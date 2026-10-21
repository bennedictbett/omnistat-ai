'use client'

import { useEffect, useRef, useState } from 'react'
import { CurveFit, formatNumber } from '@/lib/rApi'

interface Props {
  fit: CurveFit
  xLabel: string
  yLabel: string
}

type PlotlyLike = {
  react: (el: HTMLElement, data: unknown[], layout: unknown, config?: unknown) => Promise<unknown>
  purge: (el: HTMLElement) => void
}

async function loadPlotly(): Promise<PlotlyLike> {
  const mod = (await import('plotly.js-dist-min')) as unknown as PlotlyLike & { default?: PlotlyLike }
  return mod.default ?? mod
}

const PARAM_LABELS: Record<string, string> = {
  left_asymptote: 'Left asymptote (low dose)',
  right_asymptote: 'Right asymptote (high dose)',
  log10_ec50: 'log10 EC50',
  scale: 'Scale',
  Vmax: 'Vmax (Bmax)',
  Km: 'Km (Kd)',
}

const GREEN = '#4ade80'
const BLUE = '#60a5fa'
const YELLOW = '#facc15'

const CONFIG = {
  responsive: true,
  displaylogo: false,
  toImageButtonOptions: { format: 'svg', filename: 'omnistat-curve-fit' },
}

export default function RegressionPlot({ fit, xLabel, yLabel }: Props) {
  const mainRef = useRef<HTMLDivElement>(null)
  const resRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const main = mainRef.current
    const res = resRef.current
    let cancelled = false
    let plotly: PlotlyLike | null = null

    const axisBase = {
      gridcolor: '#1f2937',
      zerolinecolor: '#374151',
      linecolor: '#374151',
      type: fit.logX ? 'log' : 'linear',
    }
    const layoutBase = {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#9ca3af', size: 12 },
      margin: { l: 60, r: 20, t: 20, b: 50 },
      legend: { orientation: 'h', y: -0.25 },
    }

    const cx = fit.curve.map((c) => c.x)
    const allY = [...fit.points.map((p) => p.y), ...fit.curve.map((c) => c.lwr), ...fit.curve.map((c) => c.upr)]
    const yMin = Math.min(...allY)
    const yMax = Math.max(...allY)

    const mainTraces: unknown[] = [
      { x: cx, y: fit.curve.map((c) => c.upr), type: 'scatter', mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
      {
        x: cx,
        y: fit.curve.map((c) => c.lwr),
        type: 'scatter',
        mode: 'lines',
        line: { width: 0 },
        fill: 'tonexty',
        fillcolor: 'rgba(74,222,128,0.15)',
        hoverinfo: 'skip',
        name: '95% CI band',
      },
      { x: cx, y: fit.curve.map((c) => c.fit), type: 'scatter', mode: 'lines', line: { color: GREEN, width: 2 }, name: 'Fit' },
      { x: fit.points.map((p) => p.x), y: fit.points.map((p) => p.y), type: 'scatter', mode: 'markers', marker: { color: BLUE, size: 8 }, name: 'Data' },
    ]
    if (fit.logX && fit.ec50 !== null) {
      mainTraces.push({
        x: [fit.ec50, fit.ec50],
        y: [yMin, yMax],
        type: 'scatter',
        mode: 'lines',
        line: { color: YELLOW, width: 1.5, dash: 'dot' },
        name: 'EC50',
      })
    }

    const resX = fit.residuals.map((r) => r.x)
    const resTraces: unknown[] = [
      { x: resX, y: fit.residuals.map((r) => r.residual), type: 'scatter', mode: 'markers', marker: { color: BLUE, size: 7 }, name: 'Residual', showlegend: false },
      { x: [Math.min(...resX), Math.max(...resX)], y: [0, 0], type: 'scatter', mode: 'lines', line: { color: '#6b7280', width: 1, dash: 'dot' }, hoverinfo: 'skip', showlegend: false },
    ]

    loadPlotly()
      .then((P) => {
        if (cancelled || !main || !res) return
        plotly = P
        P.react(
          main,
          mainTraces,
          { ...layoutBase, height: 380, xaxis: { ...axisBase, title: { text: xLabel } }, yaxis: { gridcolor: '#1f2937', zerolinecolor: '#374151', title: { text: yLabel } } },
          CONFIG
        )
        P.react(
          res,
          resTraces,
          { ...layoutBase, height: 200, margin: { ...layoutBase.margin, b: 40 }, xaxis: { ...axisBase, title: { text: xLabel } }, yaxis: { gridcolor: '#1f2937', zerolinecolor: '#374151', title: { text: 'Residual' } } },
          CONFIG
        )
      })
      .catch(() => setFailed(true))

    return () => {
      cancelled = true
      if (plotly) {
        if (main) plotly.purge(main)
        if (res) plotly.purge(res)
      }
    }
  }, [fit, xLabel, yLabel])

  const fmtCi = (ci: [number, number] | null) =>
    ci ? `${formatNumber(ci[0])} to ${formatNumber(ci[1])}` : null

  const tiles: { label: string; value: string; sub?: string | null }[] = []
  if (fit.ec50 !== null) tiles.push({ label: 'EC50', value: formatNumber(fit.ec50), sub: fmtCi(fit.ec50Ci) })
  if (fit.hillSlope !== null) tiles.push({ label: 'Hill slope', value: formatNumber(fit.hillSlope), sub: fmtCi(fit.hillSlopeCi) })
  if (fit.rSquared !== null) tiles.push({ label: 'R²', value: formatNumber(fit.rSquared) })
  if (fit.n !== null) tiles.push({ label: 'n', value: String(fit.n), sub: fit.dfResidual !== null ? `${fit.dfResidual} residual df` : null })

  return (
    <div className="space-y-5">
      {tiles.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {tiles.map((t) => (
            <div key={t.label} className="bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-lg font-bold text-white font-mono">{t.value}</p>
              <p className="text-xs text-gray-500 mt-1">{t.label}</p>
              {t.sub && <p className="text-[11px] text-gray-500 font-mono mt-0.5">95% CI {t.sub}</p>}
            </div>
          ))}
        </div>
      )}

      {failed ? (
        <p className="text-sm text-red-400">The chart library could not be loaded. The fitted values are still listed below.</p>
      ) : (
        <div className="space-y-2">
          <div ref={mainRef} className="w-full" />
          <p className="text-[11px] text-gray-500">
            Shaded band: 95% confidence band of the fitted curve. Use the camera icon in the chart toolbar to save a vector (SVG) image.
          </p>
          <p className="text-xs text-gray-500">Residuals (should scatter randomly around zero)</p>
          <div ref={resRef} className="w-full" />
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="py-1 pr-4 font-normal">Parameter</th>
              <th className="py-1 pr-4 font-normal">Estimate</th>
              <th className="py-1 pr-4 font-normal">Std. error</th>
              <th className="py-1 pr-4 font-normal">95% CI</th>
            </tr>
          </thead>
          <tbody>
            {fit.parameters.map((p) => (
              <tr key={p.parameter} className="border-t border-gray-800">
                <td className="py-1 pr-4 text-gray-300">{PARAM_LABELS[p.parameter] ?? p.parameter}</td>
                <td className="py-1 pr-4 text-white font-mono">{formatNumber(p.estimate)}</td>
                <td className="py-1 pr-4 text-white font-mono">{formatNumber(p.se)}</td>
                <td className="py-1 pr-4 text-white font-mono">
                  {formatNumber(p.lwr)} to {formatNumber(p.upr)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {fit.excludedZero > 0 && (
        <p className="text-xs text-yellow-400">
          {fit.excludedZero} zero-concentration point{fit.excludedZero === 1 ? '' : 's'} left out of the fit (a log scale cannot include 0).
        </p>
      )}
    </div>
  )
}