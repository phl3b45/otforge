/// <reference types="vite/client" />
/// <reference path="../../preload/index.d.ts" />

// Electron <webview> JSX element — available when webviewTag: true is set in
// BrowserWindow webPreferences. Declared here so the renderer TypeScript compiler
// accepts <webview src="..." className="..." allowpopups /> without errors.
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string
        allowpopups?: string | boolean
        partition?: string
        preload?: string
        nodeintegration?: string | boolean
        webpreferences?: string
      },
      HTMLElement
    >
  }
}
