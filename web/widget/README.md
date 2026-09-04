# Altovix widget (Scriptable, iOS)

`altovix-widget.template.js` + `data.json` + `embed/*.png` → `../altovix-widget.scriptable.js`

    npm run build:widget

- `data.json` is the plan data the widget shows (regime, claim due-dates, per-symbol
  tranches, calendar). Regenerate it when the plans change, then rebuild.
- `embed/` holds the logo at widget resolution: the mark (168×158) and wordmark (600×75),
  each as navy-on-transparent (`-alpha`, for the paper theme) and white-on-transparent
  (`-white`, for the navy theme). They are inlined as base64 so the widget needs no network.
- The theme is chosen by the widget's Parameter field (`paper` default, `navy`), not by
  the system appearance: `Device.isUsingDarkAppearance()` is unsupported inside widgets.
  Adding `logo` to the Parameter turns a Home Screen widget into a brand tile (just the
  stacked lockup, tap opens the terminal).
- Lock Screen families (iOS 16+): `accessoryCircular` shows only the mark on the standard
  circular background; `accessoryRectangular` shows mark, wordmark, regime and today's
  count; `accessoryInline` is one line. The system renders these vibrant/monochrome, so
  they always use the white assets — colours are ignored there.
- Layout budgets: small 155×155pt, medium 329×155pt, large 329×345pt on the smaller
  iPhones; nothing may rely on SwiftUI squeezing overflow.

Import on the phone: share the built `.js` to Scriptable → Add to My Scripts (Replace when
asked). Home screen → long-press → + → Scriptable → size → Add Widget → Edit Widget →
Script: altovix-widget.
