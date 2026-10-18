// Draws LaTeX as SVG with MathJax. Loaded only when the Equations screen is opened.
// SVG output with fontCache 'none' makes every formula self-contained, so it also
// works offline (the desktop app) and when downloaded or copied as an image.
// Only the base and ams TeX packages are loaded: no \href, \class or \style, so the
// LaTeX that comes back from the server cannot add links or markup.

type Renderer = (tex: string, display: boolean) => string

let loading: Promise<Renderer> | null = null

export function loadMathJax(): Promise<Renderer> {
  if (!loading) {
    loading = (async () => {
      const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] = await Promise.all([
        import('mathjax-full/js/mathjax.js'),
        import('mathjax-full/js/input/tex.js'),
        import('mathjax-full/js/output/svg.js'),
        import('mathjax-full/js/adaptors/liteAdaptor.js'),
        import('mathjax-full/js/handlers/html.js'),
        import('mathjax-full/js/input/tex/base/BaseConfiguration.js'),
        import('mathjax-full/js/input/tex/ams/AmsConfiguration.js'),
      ])
      const adaptor = liteAdaptor()
      RegisterHTMLHandler(adaptor)
      const doc = mathjax.document('', {
        InputJax: new TeX({ packages: ['base', 'ams'] }),
        OutputJax: new SVG({ fontCache: 'none' }),
      })
      return (tex: string, display: boolean) => {
        const node = doc.convert(tex, { display })
        return adaptor.outerHTML(node)
      }
    })()
    // a failed load (for example a lost connection) can be retried next time
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}