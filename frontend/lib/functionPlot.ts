import type { Data, Layout } from 'plotly.js-dist-min'
import {
  ChartError,
  Figure,
  StylePreset,
  axisFor,
  baseLayout,
  figureConfig,
  formatStat,
  quantile,
  sceneAxisFor,
  themeFor,
} from './chartStudio'

// Typed-function plotter. Turns text such as "sin(x)/x" or "x^2 + y^2" into curves and surfaces.
// The text is read by the small parser below and never passed to eval, so nothing a user types can run as code.
// No React and no Plotly runtime in here, so everything is easy to test.

export const MAX_FUNCTIONS = 6
export const MAX_EXPRESSION_LENGTH = 300
/** Steps along x for a curve (the curve has one more point than this). */
export const CURVE_STEPS = 1000
/** Points along each axis of a surface. */
export const SURFACE_GRID = 80

/** An error in typed text. The message is safe to show to the user. */
export class ExpressionError extends ChartError {}

// ---------- Names the parser knows ----------

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

interface FunctionDef {
  arity: number
  fn: (...a: number[]) => number
}

const FUNCTIONS: Record<string, FunctionDef> = {
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  sec: { arity: 1, fn: (a) => 1 / Math.cos(a) },
  csc: { arity: 1, fn: (a) => 1 / Math.sin(a) },
  cot: { arity: 1, fn: (a) => 1 / Math.tan(a) },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  atan2: { arity: 2, fn: Math.atan2 },
  sinh: { arity: 1, fn: Math.sinh },
  cosh: { arity: 1, fn: Math.cosh },
  tanh: { arity: 1, fn: Math.tanh },
  exp: { arity: 1, fn: Math.exp },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log10 }, // base 10, as on a calculator; ln is the natural logarithm
  log10: { arity: 1, fn: Math.log10 },
  log2: { arity: 1, fn: Math.log2 },
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  abs: { arity: 1, fn: Math.abs },
  sign: { arity: 1, fn: Math.sign },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  round: { arity: 1, fn: Math.round },
  min: { arity: 2, fn: Math.min },
  max: { arity: 2, fn: Math.max },
  pow: { arity: 2, fn: Math.pow },
  mod: { arity: 2, fn: (a, b) => ((a % b) + b) % b }, // result takes the sign of b, so mod(-1, 3) is 2
}

// Plain objects also "contain" inherited names such as constructor and __proto__; only own names count.
const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)

/** The names shown in the help text. */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS)

// ---------- Reading the text ----------

type TokenType = 'num' | 'id' | 'op' | '(' | ')' | ',' | 'end'
interface Token {
  type: TokenType
  text: string
  value?: number
}

/** Tidies typed text: unusual symbols, a leading "y =" or "f(x) =", capitals, and other kinds of brackets. */
function normalise(src: string): string {
  let s = src
    .replace(/[−–—]/g, '-')
    .replace(/[×·⋅]/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/√/g, 'sqrt')
    .replace(/[[{]/g, '(')
    .replace(/[\]}]/g, ')')
    .trim()
  s = s.replace(/^(?:[a-z]\s*\(\s*[a-z](?:\s*,\s*[a-z])?\s*\)|[yz])\s*=(?!=)\s*/i, '')
  return s.toLowerCase()
}

function tokenize(s: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const rest = s.slice(i)
    const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/.exec(rest)
    if (num) {
      tokens.push({ type: 'num', text: num[0], value: Number(num[0]) })
      i += num[0].length
      continue
    }
    const id = /^[a-z_][a-z0-9_]*/.exec(rest)
    if (id) {
      const word = id[0]
      // "xy" means x times y
      if (/^[xy]{2,}$/.test(word)) for (const ch of word) tokens.push({ type: 'id', text: ch })
      else tokens.push({ type: 'id', text: word })
      i += word.length
      continue
    }
    if (c === '*' && s[i + 1] === '*') {
      tokens.push({ type: 'op', text: '^' })
      i += 2
      continue
    }
    if ('+-*/^'.includes(c)) {
      tokens.push({ type: 'op', text: c })
    } else if (c === '(' || c === ')' || c === ',') {
      tokens.push({ type: c, text: c })
    } else if (c === '=') {
      throw new ExpressionError('Type only the right-hand side, such as x^2 or sin(x)*cos(y), without an equals sign.')
    } else {
      throw new ExpressionError(`The character "${c}" is not allowed. Use numbers, x, y, + - * / ^, brackets and function names.`)
    }
    i++
  }
  tokens.push({ type: 'end', text: '' })
  return tokens
}

type Node =
  | { k: 'num'; v: number }
  | { k: 'var'; n: 'x' | 'y' }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { k: 'call'; f: string; args: Node[] }

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private look(): Token {
    return this.tokens[this.pos]
  }
  private next(): Token {
    return this.tokens[this.pos++]
  }

  parse(): Node {
    const node = this.expression()
    const t = this.look()
    if (t.type === ')') throw new ExpressionError('There is a ")" with no matching "(".')
    if (t.type === ',') throw new ExpressionError('A comma can only be used between the values of a function such as max(x, 2).')
    if (t.type !== 'end') throw new ExpressionError(`Unexpected "${t.text}".`)
    return node
  }

  // expression := term (('+' | '-') term)*
  private expression(): Node {
    let left = this.term()
    while (this.look().type === 'op' && (this.look().text === '+' || this.look().text === '-')) {
      const op = this.next().text as '+' | '-'
      left = { k: 'bin', op, a: left, b: this.term() }
    }
    return left
  }

  // term := unary (('*' | '/' | implied multiplication) unary)*
  private term(): Node {
    let left = this.unary()
    for (;;) {
      const t = this.look()
      if (t.type === 'op' && (t.text === '*' || t.text === '/')) {
        this.next()
        left = { k: 'bin', op: t.text as '*' | '/', a: left, b: this.unary() }
      } else if (t.type === 'num' || t.type === 'id' || t.type === '(') {
        // 2x, 2(x+1), x sin(x), (x+1)(x-1)
        if (left.k === 'num' && t.type === 'num') {
          throw new ExpressionError(`Two numbers in a row ("${this.tokens[this.pos - 1].text} ${t.text}"). Put an operator such as + or * between them.`)
        }
        left = { k: 'bin', op: '*', a: left, b: this.power() }
      } else {
        return left
      }
    }
  }

  // unary := ('-' | '+') unary | power      (so -x^2 means -(x^2))
  private unary(): Node {
    const t = this.look()
    if (t.type === 'op' && (t.text === '-' || t.text === '+')) {
      this.next()
      const operand = this.unary()
      return t.text === '-' ? { k: 'neg', a: operand } : operand
    }
    return this.power()
  }

  // power := primary ('^' unary)?      (right-leaning: 2^3^2 is 2^9)
  private power(): Node {
    const base = this.primary()
    if (this.look().type === 'op' && this.look().text === '^') {
      this.next()
      return { k: 'bin', op: '^', a: base, b: this.unary() }
    }
    return base
  }

  private primary(): Node {
    const t = this.next()
    if (t.type === 'num') return { k: 'num', v: t.value as number }
    if (t.type === '(') {
      const inner = this.expression()
      if (this.look().type !== ')') throw new ExpressionError('A bracket "(" is never closed. Add the matching ")".')
      this.next()
      return inner
    }
    if (t.type === 'id') return this.name(t.text)
    if (t.type === 'end') {
      const before = this.tokens[this.pos - 2]
      throw new ExpressionError(before ? `The expression ends too soon: something is missing after "${before.text}".` : 'Type a function.')
    }
    if (t.type === ')') throw new ExpressionError('Unexpected ")": a number, x, or a function is needed before it.')
    throw new ExpressionError(`Unexpected "${t.text}": a number, x, or a function is needed here.`)
  }

  private name(id: string): Node {
    if (id === 'x' || id === 'y') return { k: 'var', n: id }
    if (hasOwn(CONSTANTS, id)) return { k: 'num', v: CONSTANTS[id] }
    if (hasOwn(FUNCTIONS, id)) {
      if (this.look().type !== '(') throw new ExpressionError(`Write ${id} with brackets, for example ${id}(x).`)
      this.next()
      const args: Node[] = []
      if (this.look().type !== ')') {
        for (;;) {
          args.push(this.expression())
          if (this.look().type === ',') {
            this.next()
            continue
          }
          break
        }
      }
      if (this.look().type !== ')') throw new ExpressionError(`The bracket after ${id} is never closed. Add the matching ")".`)
      this.next()
      const want = FUNCTIONS[id].arity
      if (args.length !== want) {
        throw new ExpressionError(`${id} needs ${want} ${want === 1 ? 'value' : 'values'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given.`)
      }
      return { k: 'call', f: id, args }
    }
    if (this.look().type === '(') throw new ExpressionError(`Unknown function "${id}". Check the spelling, or see the list of functions below the boxes.`)
    throw new ExpressionError(`Unknown name "${id}". Use x (and y for a surface), pi, e, or a function such as sin(x).`)
  }
}

// ---------- Evaluating ----------

export type PlotFunction = (x: number, y: number) => number

function compile(node: Node): PlotFunction {
  switch (node.k) {
    case 'num': {
      const v = node.v
      return () => v
    }
    case 'var':
      return node.n === 'x' ? (x) => x : (_x, y) => y
    case 'neg': {
      const a = compile(node.a)
      return (x, y) => -a(x, y)
    }
    case 'bin': {
      const a = compile(node.a)
      const b = compile(node.b)
      switch (node.op) {
        case '+':
          return (x, y) => a(x, y) + b(x, y)
        case '-':
          return (x, y) => a(x, y) - b(x, y)
        case '*':
          return (x, y) => a(x, y) * b(x, y)
        case '/':
          return (x, y) => a(x, y) / b(x, y)
        case '^':
          return (x, y) => Math.pow(a(x, y), b(x, y))
      }
      break
    }
    case 'call': {
      const f = FUNCTIONS[node.f].fn
      const args = node.args.map(compile)
      if (args.length === 1) {
        const a = args[0]
        return (x, y) => f(a(x, y))
      }
      const [a, b] = args
      return (x, y) => f(a(x, y), b(x, y))
    }
  }
  throw new ExpressionError('Could not read this function.')
}

function usedVariables(node: Node, into: { x: boolean; y: boolean }): void {
  switch (node.k) {
    case 'var':
      into[node.n] = true
      break
    case 'neg':
      usedVariables(node.a, into)
      break
    case 'bin':
      usedVariables(node.a, into)
      usedVariables(node.b, into)
      break
    case 'call':
      node.args.forEach((a) => usedVariables(a, into))
      break
  }
}

export interface ParsedExpression {
  /** The text as it will be used in labels: tidied, without a leading "y =" */
  source: string
  fn: PlotFunction
  /** Which variables the expression uses. If it uses y, it is a surface. */
  uses: { x: boolean; y: boolean }
}

/** Reads typed text. Throws an ExpressionError that says what is wrong in plain words. */
export function parseExpression(src: string): ParsedExpression {
  if (src.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(`This is too long (more than ${MAX_EXPRESSION_LENGTH} characters).`)
  }
  const source = normalise(src)
  if (source === '') throw new ExpressionError('Type a function, for example sin(x) or x^2 + y^2.')
  const ast = new Parser(tokenize(source)).parse()
  const uses = { x: false, y: false }
  usedVariables(ast, uses)
  return { source, fn: compile(ast), uses }
}

/** Reads text that must be one number, such as "10" or "-2pi", for the range boxes. */
export function evaluateConstant(src: string, what: string): number {
  let parsed: ParsedExpression
  try {
    parsed = parseExpression(src)
  } catch (e) {
    if (e instanceof ExpressionError) throw new ExpressionError(`${what}: ${e.message}`)
    throw e
  }
  if (parsed.uses.x || parsed.uses.y) throw new ExpressionError(`${what} must be a number such as 10 or -2*pi, not a function of x or y.`)
  const v = parsed.fn(0, 0)
  if (!Number.isFinite(v)) throw new ExpressionError(`${what} is not a number.`)
  return v
}

// ---------- Drawing ----------

export interface FunctionPlotConfig {
  /** One typed function per entry; blank entries are ignored */
  exprs: string[]
  xMin: number
  xMax: number
  /** Only used for surfaces */
  yMin: number
  yMax: number
  preset: StylePreset
}

function linspace(lo: number, hi: number, steps: number): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => lo + ((hi - lo) * i) / steps)
}

interface ViewRange {
  lo: number
  hi: number
  /** True when extreme values (a function shooting off to infinity) were left outside the view */
  trimmed: boolean
}

/**
 * Chooses a vertical range that keeps the interesting part readable. Normally that is the full range of the values.
 * When a few values are far beyond the rest (1/x near 0, tan(x) at its jumps), the view follows the bulk
 * of the values instead, so the shape is not squashed flat.
 */
export function viewRange(sorted: number[]): ViewRange {
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const q05 = quantile(sorted, 0.05)
  const q95 = quantile(sorted, 0.95)
  const span = q95 - q05
  if (span > 0 && max - min > 10 * span) {
    return { lo: Math.max(min, q05 - span * 0.5), hi: Math.min(max, q95 + span * 0.5), trimmed: true }
  }
  return { lo: min, hi: max, trimmed: false }
}

function padded(r: ViewRange): [number, number] {
  const pad = (r.hi - r.lo) * 0.05 || 1
  return [r.lo - pad, r.hi + pad]
}

function finiteSorted(lists: (number | null)[][]): number[] {
  const out: number[] = []
  for (const list of lists) for (const v of list) if (v !== null) out.push(v)
  return out.sort((a, b) => a - b)
}

function plainNumber(n: number): string {
  return formatStat(n)
}

/**
 * Where a curve jumps between very different values on opposite sides of zero (tan(x) at its asymptotes, 1/x at 0),
 * puts a gap in the line so Plotly does not draw a false vertical stroke across the chart.
 */
function breakAtJumps(xs: number[], ys: (number | null)[], span: number): { x: number[]; y: (number | null)[] } {
  const x: number[] = []
  const y: (number | null)[] = []
  for (let i = 0; i < xs.length; i++) {
    const v = ys[i]
    const prev = i > 0 ? ys[i - 1] : null
    if (v !== null && prev !== null && v * prev < 0 && Math.abs(v - prev) > span * 0.8) {
      x.push(xs[i])
      y.push(null)
    }
    x.push(xs[i])
    y.push(v)
  }
  return { x, y }
}

function checkRange(name: string, lo: number, hi: number): void {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new ChartError(`The ${name} range must be numbers.`)
  if (lo >= hi) throw new ChartError(`The ${name} range must start below where it ends (now ${plainNumber(lo)} to ${plainNumber(hi)}).`)
}

export function buildFunctionFigure(cfg: FunctionPlotConfig): Figure {
  const sources = cfg.exprs.map((s) => s.trim()).filter((s) => s !== '')
  if (sources.length === 0) throw new ChartError('Type a function to plot, for example sin(x) or x^2 + y^2.')
  if (sources.length > MAX_FUNCTIONS) throw new ChartError(`At most ${MAX_FUNCTIONS} functions can be drawn together.`)

  const parsed = sources.map((s, i) => {
    try {
      return parseExpression(s)
    } catch (e) {
      if (e instanceof ExpressionError && sources.length > 1) throw new ExpressionError(`Function ${i + 1}: ${e.message}`)
      throw e
    }
  })
  checkRange('x', cfg.xMin, cfg.xMax)
  const surface = parsed.some((p) => p.uses.y)
  if (surface) checkRange('y', cfg.yMin, cfg.yMax)
  return surface ? buildSurfaces(parsed, cfg) : buildCurves(parsed, cfg)
}

function buildCurves(parsed: ParsedExpression[], cfg: FunctionPlotConfig): Figure {
  const t = themeFor(cfg.preset)
  const multi = parsed.length > 1
  const xs = linspace(cfg.xMin, cfg.xMax, CURVE_STEPS)
  const series = parsed.map((p) => xs.map((x) => {
    const v = p.fn(x, 0)
    return Number.isFinite(v) ? v : null
  }))

  const all = finiteSorted(series)
  if (all.length === 0) {
    throw new ChartError(
      `${multi ? 'None of these functions has' : 'This function has'} a real value between x = ${plainNumber(cfg.xMin)} and x = ${plainNumber(cfg.xMax)}. Try a different range.`
    )
  }
  const view = viewRange(all)
  const span = view.hi - view.lo

  const notes: string[] = []
  let plotted = 0
  let skipped = 0
  const data: Data[] = parsed.map((p, i) => {
    const colour = t.palette[i % t.palette.length]
    const finiteCount = series[i].filter((v) => v !== null).length
    plotted += finiteCount
    skipped += series[i].length - finiteCount
    if (finiteCount === 0) {
      notes.push(`"${p.source}" has no real value in this range, so nothing is drawn for it.`)
    } else if (finiteCount < series[i].length) {
      notes.push(`"${p.source}" has no real value at some points of this range, so the line is broken there.`)
    }
    const line = breakAtJumps(xs, series[i], span)
    return {
      type: 'scatter',
      mode: 'lines',
      name: p.source,
      x: line.x,
      y: line.y,
      connectgaps: false,
      line: { color: colour, width: cfg.preset === 'graphpad' ? 3 : 2.5 },
      showlegend: multi,
      hovertemplate: `x: %{x:.5g}<br>y: %{y:.5g}<extra>${multi ? p.source : ''}</extra>`,
    } as Data
  })

  const zeroLine = cfg.preset === 'graphpad' ? '#9ca3af' : '#6b7280'
  const layout: Partial<Layout> = baseLayout(t, multi)
  layout.xaxis = { ...axisFor('x', t), zeroline: true, zerolinecolor: zeroLine, zerolinewidth: 1 }
  layout.yaxis = { ...axisFor('y', t), zeroline: true, zerolinecolor: zeroLine, zerolinewidth: 1 }
  if (view.trimmed) {
    layout.yaxis = { ...layout.yaxis, range: padded(view), autorange: false }
    notes.push('The vertical range is limited so the shape stays readable near points where the curve shoots off. Zoom out to see more.')
  }

  return {
    data,
    layout,
    config: figureConfig(),
    plotted,
    skipped,
    groups: parsed.length,
    notes,
    caption: `${parsed.map((p) => `y = ${p.source}`).join(',  ')}  for x from ${plainNumber(cfg.xMin)} to ${plainNumber(cfg.xMax)}.`,
  }
}

function buildSurfaces(parsed: ParsedExpression[], cfg: FunctionPlotConfig): Figure {
  const t = themeFor(cfg.preset)
  const multi = parsed.length > 1
  const xs = linspace(cfg.xMin, cfg.xMax, SURFACE_GRID - 1)
  const ys = linspace(cfg.yMin, cfg.yMax, SURFACE_GRID - 1)
  // z[row][column]: one row per y value, one column per x value
  const grids = parsed.map((p) =>
    ys.map((y) =>
      xs.map((x) => {
        const v = p.fn(x, y)
        return Number.isFinite(v) ? v : null
      })
    )
  )

  const all = finiteSorted(grids.flat())
  if (all.length === 0) {
    throw new ChartError(
      `${multi ? 'None of these functions has' : 'This function has'} a real value in this range. Try a different range.`
    )
  }
  const view = viewRange(all)

  const notes: string[] = []
  let plotted = 0
  let skipped = 0
  const data: Data[] = parsed.map((p, i) => {
    const grid = grids[i]
    const cells = grid.length * grid[0].length
    const finite = grid.reduce((n, row) => n + row.filter((v) => v !== null).length, 0)
    plotted += finite
    skipped += cells - finite
    if (finite === 0) notes.push(`"${p.source}" has no real value in this range, so nothing is drawn for it.`)
    else if (finite < cells) notes.push(`"${p.source}" has no real value in part of this range, so the surface has holes there.`)

    const colour = t.palette[i % t.palette.length]
    const colourScale = multi
      ? [[0, colour], [1, colour]]
      : cfg.preset === 'graphpad'
        ? [[0, '#f3f4f6'], [1, '#111111']]
        : 'Viridis'
    return {
      type: 'surface',
      name: p.source,
      x: xs,
      y: ys,
      z: grid,
      colorscale: colourScale,
      ...(view.trimmed ? { cmin: view.lo, cmax: view.hi } : {}),
      opacity: multi ? 0.85 : 1,
      showscale: !multi,
      ...(multi
        ? {}
        : { colorbar: { thickness: 14, len: 0.7, outlinewidth: 0, tickfont: { color: t.text, size: t.fontSize } } }),
      showlegend: multi,
      hovertemplate: `x: %{x:.4g}<br>y: %{y:.4g}<br>z: %{z:.4g}<extra>${multi ? p.source : ''}</extra>`,
    } as Data
  })

  const layout: Partial<Layout> = baseLayout(t, multi)
  layout.scene = {
    xaxis: sceneAxisFor('x', cfg.preset, t),
    yaxis: sceneAxisFor('y', cfg.preset, t),
    zaxis: sceneAxisFor('z', cfg.preset, t, view.trimmed ? { range: padded(view), autorange: false } : {}),
    // A fixed, shallow height so a surface that is only a few units tall is not stretched up to the width of its base
    aspectmode: 'manual',
    aspectratio: { x: 1, y: 1, z: 0.7 },
    // A little further back and lower than the default, so the corner labels are not cut off and the relief shows
    camera: { eye: { x: 1.6, y: 1.6, z: 1.0 } },
  } as Layout['scene']
  layout.margin = { l: 0, r: 0, t: 10, b: 0 }
  delete layout.plot_bgcolor // 3D charts have no 2D plot area
  if (view.trimmed) notes.push('The height (z) range is limited so the shape stays readable near points where the surface shoots off.')

  return {
    data,
    layout,
    config: figureConfig(),
    plotted,
    skipped,
    groups: parsed.length,
    notes,
    caption:
      `${parsed.map((p) => `z = ${p.source}`).join(',  ')}  for x from ${plainNumber(cfg.xMin)} to ${plainNumber(cfg.xMax)}` +
      ` and y from ${plainNumber(cfg.yMin)} to ${plainNumber(cfg.yMax)}. Drag to rotate.`,
  }
}