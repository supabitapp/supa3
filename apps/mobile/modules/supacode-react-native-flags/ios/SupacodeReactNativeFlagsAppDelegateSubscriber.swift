import ExpoModulesCore

// AppDelegate creates the React Native factory, which installs the default
// feature flags, before it forwards didFinishLaunching to subscribers. React
// Native starts later, when the scene connects.
public class SupacodeReactNativeFlagsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    SupacodeReactNativeFeatureFlags.applyOverrides()
    return true
  }
}
