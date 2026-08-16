// Type shims so `tsc --noEmit` accepts the CSS imports the Expo SDK 57 template
// ships (web styling). React Native bundles these via Metro; tsc needs the
// module declarations to not error on them.
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}
declare module "*.css";
