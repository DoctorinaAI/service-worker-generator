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

`SW_E2E_BROWSERS` picks the engines: `all`, or a list such as `firefox,webkit`.
Without it, only Chromium runs. `npm run build:all` matters after any change in
`packages/sw/src`: without it `sw:generate` embeds the previous worker and the
tests pass or fail against old code.

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

### Known engine differences

| Engine | Behaviour | In the suite |
|---|---|---|
| Firefox | With navigation preload on, a refused connection fails the navigation although the worker catches the rejection and answers from cache. `setOffline` does not show this. | Pinned by `firefoxRefusesNavigation` in `origin-faults.spec.ts` |
| WebKit | `context.setOffline(true)` fails the navigation with an internal error. A real outage works. | `test.skip` in `app-shell.spec.ts` |

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
