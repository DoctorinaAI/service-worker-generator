# Testing

The worker is tested at three levels. Each one catches what the one before it
cannot.

| Level | Tool | Command | Covers |
|---|---|---|---|
| Unit | Vitest with the mocks in `packages/sw/src/__tests__/helpers.ts` | `npm test` | Retry and backoff, cache ownership, cache swap, `sw-progress` |
| Browser | Playwright on Chromium, Firefox and WebKit | `npm -w packages/sw run e2e:all` | Real lifecycle, CacheStorage, navigations, bootstrap |
| Device | Manual, see the checklist below | Before a release | iOS Safari, which no CI engine stands in for |

## Browser tests

The specs need a generated build:

```bash
npm run build:all
cd example && flutter build web --release -o build/web && cd ..
dart run sw:generate --input=example/build/web
npx -w packages/sw playwright install chromium firefox webkit
npm -w packages/sw run e2e:all
```

The specs are served by `e2e/support/serve.mjs`, which Playwright starts
itself — Node, so it answers requests concurrently and runs on Windows. A
single-threaded static server (`python3 -m http.server`, as this used to be)
stalls for 30 s whenever a browser opens a speculative connection without
sending a request, which failed the app-shell specs in CI at random.

`SW_E2E_BROWSERS` picks the engines: `all`, or a list such as `firefox,webkit`.
Without it, only Chromium runs. `npm run build:all` matters after any change in
`packages/sw/src`: without it `sw:generate` embeds the previous worker and the
tests pass or fail against old code.

Run `dart test --tags=integration` *before* `sw:generate`, not after. Those
tests copy `example/build/web` into a temporary directory and run the
generator over the copy, and the generator refuses a build it has already
processed — so once the command above has run, every one of them fails with
"This build was already processed" until the next `flutter build web`. The
workflow does them in that order for the same reason.

### Writing a test

- **Observe the origin, not the page.** Use `Host` from `e2e/support/host.ts`.
  `page.route()` does not see the worker's own fetches, while the origin sees
  them in every engine. `Host` records requests, injects faults through `fault`
  and goes away with `down()`.
- **Ask from the page.** `context.serviceWorkers()` is Chromium-only. Use
  `cachedText`, `controllerUrl` and `workerVersion`, which work everywhere.
- **Take the origin down instead of using `setOffline`.** The emulation differs
  from a real outage in both directions, as the known differences below show.
- **Wait for a condition.** `settle` and `expect.poll` hold on a slow runner
  where a fixed sleep does not. Something that must not happen has no condition
  to wait for: watch it for a while, as `expectShellIntact` does.
- **Prove the scenario ran.** A check like "nothing is installing" is also true
  before the install starts. Assert on the origin that the worker got that far.

### What the browser suite covers

| Spec | Scenario |
|---|---|
| `app-shell`, `app-shell-integrity` | The shell is pre-cached under its manifest key, answers a deep route and a failed navigation, and nothing else may take its slot |
| `bootstrap` | The page boots, the widget mounts, `data-config` is read, and a wedged service worker job queue does not stop the app |
| `engine-update` | The first load after a deploy, on the same engine and on a changed one |
| `deploy-reuse` | A deploy that changed nothing but its version downloads no code again |
| `two-tabs` | A second tab open across a deploy: the reloaded one runs the new build, the other keeps its own, the new worker waits |
| `base-href` | An app under `<base href="/app/">`: scope, cache keys, deep routes and the host's reserved namespace |
| `canvaskit-fallback` | The engine from the CDN, and from the local copy when the CDN does not have this build's revision |
| `fetch-routing` | Redirects, `Range`, POST, lazy caching, navigation preload, the version protocol |
| `origin-faults` | An origin that is down, 500s, fails once, or breaks a deploy's Core file |
| `storage-purge` | Caches or registrations gone, a single evicted file, a refill that 503s |
| `progress-counter` | The counter never passes its total, cold and warm |
| `logging` | `--log-level=silent` really is silent, with the default as the control |

Still uncovered, and why: a quota that runs out (no way to fill a browser's
storage from a test in reasonable time), multithreaded skwasm under
COOP/COEP (the example is a canvaskit build, and the headers need a host
that sets them), the stall overlay (its threshold is 30 s, and 120 s where
nothing reports progress), and a host that serves a stale `bootstrap.js`.

### Known engine differences

| Engine | Behaviour | In the suite |
|---|---|---|
| Firefox 159 | `page.reload()` sends the worker two fetch events for `main.dart.js`, from two clients about 50 ms apart, so two cache misses refill it side by side. | `storage-purge.spec.ts` counts at least two refills by hash, not exactly two |
| WebKit | `page.route` does not intercept the CanvasKit CDN probe, so a test that "blocks" the CDN that way sees it answer anyway. | `canvaskit-fallback.spec.ts` deploys an engine revision the CDN does not have instead of intercepting |
| Firefox | With navigation preload on, a refused connection fails the navigation although the worker catches the rejection and answers from cache. `setOffline` does not show this. | Pinned by `firefoxRefusesNavigation` in `origin-faults.spec.ts` |
| WebKit | `preloadResponse` never settles for a navigation the worker already answered, Safari included. A wait on it under `waitUntil` keeps the worker busy for good, and a newer build cannot activate. | `a navigation answered from the shell does not hold the next build back` in `origin-faults.spec.ts`; the wait is bounded by `LATE_SHELL_TIMEOUT_MS` |
| WebKit | `context.setOffline(true)` fails the navigation with an internal error. A real outage works. | `test.skip` in `app-shell.spec.ts` |
| WebKit | Activating a worker on a CI runner sometimes takes longer than the 30 s a spec allows, so `settle` times out — two of ten runs of one unchanged tree, on a different spec each time. | `retries: 2` under `CI`, which reports them as flaky rather than failing the run |

Playwright's Firefox and WebKit are patched builds, and on Linux its WebKit is
not Safari. A pass there is not a pass on an iPhone.

## Device checklist

On a real iPhone, in Safari and from the home screen:

- [ ] A cold load reaches the first frame and shows progress.
- [ ] A second load is served by the worker.
- [ ] A load after a deploy runs the new build.
- [ ] A load with no network shows the cached shell and a clear failure.
- [ ] CanvasKit loads, from the CDN and from the local fallback.

A cloud device farm such as BrowserStack or Sauce Labs can run this. Its tunnel
must keep a secure context, `localhost` or valid HTTPS, or the worker will not
register.

## References

- [Web Platform Tests: service workers](https://github.com/web-platform-tests/wpt/tree/master/service-workers/service-worker):
  scenarios for edge cases.
- [wpt.fyi](https://wpt.fyi/results/service-workers): whether a failure is a
  known engine gap.
- [Workbox tests](https://github.com/GoogleChrome/workbox/tree/v7/test): the same
  strategies, tested by another project.
- [Playwright: service workers](https://playwright.dev/docs/service-workers)
