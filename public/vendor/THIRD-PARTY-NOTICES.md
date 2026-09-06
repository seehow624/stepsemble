# Vendored third-party assets

These files retain their upstream licenses; the Stepsemble Apache-2.0 license
does not replace the licenses of bundled third-party code. Existing license
banners in the JavaScript bundles are preserved.

## Marked 15.0.7

- Source: https://github.com/markedjs/marked/tree/v15.0.7
- License: MIT, with the upstream Markdown attribution and redistribution notice
- Bundle: `marked.min.js`
- Complete upstream notices: [`licenses/marked-LICENSE.md`](licenses/marked-LICENSE.md)

## DOMPurify 3.2.4

- Source: https://github.com/cure53/DOMPurify/tree/3.2.4
- License: Apache-2.0 OR MPL-2.0, as offered by the upstream project
- Bundle: `purify.min.js`
- Complete upstream notices: [`licenses/DOMPurify-LICENSE.txt`](licenses/DOMPurify-LICENSE.txt)

## Mermaid 11.12.1

- Source: https://www.npmjs.com/package/mermaid/v/11.12.1
- License: MIT
- Complete upstream license: [`licenses/mermaid-LICENSE.txt`](licenses/mermaid-LICENSE.txt)
- Bundle: `mermaid.min.js`
- Vendored bundle SHA-256: `198b19442f86f0b46a17e56d3abf744c3a28a3427e66fa8dada3b589a77babcc`

The bundle retains the upstream license notices for Mermaid and its bundled
MIT-licensed dependencies. It is loaded lazily from the same Stepsemble host;
Mermaid diagram source is not sent to a CDN.
