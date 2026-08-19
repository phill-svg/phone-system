// Dynamic Expo config. It extends app.json (passed in as `config`) and, when the `test` EAS build
// profile runs (which sets APP_VARIANT=test), gives the build its OWN name + bundle id so the test
// app installs alongside any real build and never clashes. Every other setting — plugins, splash,
// experiments, icons — is inherited unchanged from app.json.
const IS_TEST = process.env.APP_VARIANT === "test";

const BUNDLE_ID = IS_TEST
  ? "au.com.tcbpestcontrolcanberra.tcbphone.test"
  : "au.com.tcbpestcontrolcanberra.tcbphone";

module.exports = ({ config }) => ({
  ...config,
  name: IS_TEST ? "TCB Phone (Test)" : "TCB Phone",
  ios: {
    ...config.ios,
    bundleIdentifier: BUNDLE_ID,
  },
  android: {
    ...config.android,
    package: BUNDLE_ID,
  },
});
