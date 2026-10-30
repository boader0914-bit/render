# Pinned Data charts 1.2.1

These are the official chart component assets, served locally by the existing
application. `element.js` and `runtime.js` are byte-for-byte upstream files.
`manifest.json` records their origin, bytes, SHA256, dependency audit, notices,
and exact static style hashes. No `library.js` or Data App shell is needed.

The directory suffix `data-analytics-plugin/1.2.1/charts/` must be preserved:
the official element verifies that immutable release URL before loading its
sibling `runtime.js`. Both requests stay on the application's origin. The
runtime has no further imports, fetch calls, workers, or eval/Function calls.
Diagnostic strings containing documentation URLs are not asset dependencies.

Load `chart-host.css` as a local stylesheet. The application owns its resolved
light/dark appearance and may override the inherited chart variables. Do not
modify the vendor files to change the theme. The production CSP remains intact;
the manifest lists the three exact inline style hashes for a stricter local
preview without allowing arbitrary inline styles or external script origins.

`THIRD_PARTY_NOTICES.txt` is copied verbatim from the installed Data plugin's
Visualize chart distribution. It preserves the bundled third-party license
notices; it is not an assertion that every upstream file has one project-wide
license. The downloaded JavaScript does not supply a separate license header.

The application adapter is `web/keyword-monthly-charts.js`:

```js
const chart = await window.KeywordMonthlyCharts.mount(container, {
  id: "keyword-monthly-daily",
  title: "숙박일별 예약 추정률",
  height: 280,
  spec: {
    type: "line", x: "date", y: ["선택 업체", "전체 표본"],
    yDomain: [0, 1], valueFormat: { style: "percent", maximumFractionDigits: 1 }
  },
  rows: reviewedRows
});
```

The promise resolves on the official `data-chart-ready` event, not just element
creation. Import/validation/render errors reject. Disconnecting or superseding
a pending chart rejects with `name === "AbortError"`; a caller must not use that
old cancellation to overwrite the current view. Removing the element invokes
the official component's disposal. The adapter sets `data-data-chart` on its
container and `data-keyword-monthly-chart="1.2.1"` on the actual component.

Contract verification with the actual pinned `checkedPayload` export accepted
line-series null gaps. A horizontal stack with either one unknown null/null
category or a mixture of known and unknown categories was rejected, as the bar
guide requires complete additive parts. Only valid stack rows may be charted;
unknown companies remain in the application's full roster table/list. Never
replace them with zero. This is source/contract validation, not a browser render
claim. Horizontal charts allow at most 38 categories with height at least
`40 + 20 * categoryCount` and at most 800 pixels. Larger rosters require explicit
separate pages/charts while preserving the full comparison population.
