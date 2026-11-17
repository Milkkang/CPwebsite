# CP Value Mart · Soft Grocery Preview

Source export of the existing CP Value Mart Sites design preview, including the storefront, admin dashboard and product images.

## Run locally

Serve the `dist/` directory with a static HTTP server, for example:

```sh
python3 -m http.server 8080 --directory dist
```

Then open http://localhost:8080. No build or dependency installation is required.

## Preview data

This is an interactive design prototype. Product prices, stock, orders and sign-in are simulated; browser-local changes are stored in localStorage. There is no production database, live payment processing or real order service connected.

## Source

Exported from Sites project `appgprj_6afbc995114c8191b7d0d5fe9a8e7629` at commit `1836d4c7f1cd493c4a1932d07ab4cba3665e9b9e`.

The `.openai/hosting.json` file records the original Sites project configuration. Uploading this source does not enable GitHub Pages or redeploy the original site.
