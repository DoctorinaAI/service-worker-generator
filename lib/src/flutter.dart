/// Flutter template for loading a Flutter web application with a progress bar.
/// https://docs.flutter.dev/platform-integration/web/initialization
String flutterTemplate() =>
    '''
    {{flutter_js}}
    {{flutter_build_config}}

    function progress(value) {
      let el = document.getElementById("progress");
      if (el) el.firstElementChild.style.width = value + "%";
    }

    window.addEventListener('load', function (ev) {
      progress(30);
    });

    window.addEventListener('flutter-first-frame', function () {
      let el = document.getElementById("loading");
      if (el) el.remove();
    });

    _flutter.loader.load({
      onEntrypointLoaded: async function (engineInitializer) {
        progress(60);
        const appRunner = await engineInitializer.initializeEngine();
        progress(100);
        await new Promise(resolve => setTimeout(resolve, 200));
        await appRunner.runApp();
      }
    });
'''
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
