import 'package:sw_example/src/update/update_check_api.dart';
import 'package:sw_example/src/update/platform/update_check_api_vm.dart'
    if (dart.library.js_interop) 'package:sw_example/src/update/platform/update_check_api_web.dart'
    as platform;

UpdateCheckApi createUpdateCheckApi() => platform.createUpdateCheckApi();
