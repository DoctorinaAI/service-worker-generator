import 'package:sw_example/src/update/platform/update_check_vm.dart'
    if (dart.library.js_interop) 'package:sw_example/src/update/platform/update_check_js.dart'
    as platform;
import 'package:sw_example/src/update/update_check_api.dart';

export 'update_check_vm.dart'
    // ignore: uri_does_not_exist
    if (dart.library.js_interop) 'update_check_js.dart';

UpdateCheckApi createUpdateCheckApi() => platform.createUpdateCheckApi();
