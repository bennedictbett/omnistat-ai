import { Explanation, ExplanationPart } from '@/lib/explainResult'

function Sentence({ parts }: { parts: ExplanationPart[] }) {
  return (
    <>
      {parts.map((part, i) => typeof part === 'string' ? part : (
        <span key={i} title={`Source: ${part.source}`} data-source={part.source}
          className="font-mono text-white underline decoration-dotted decoration-gray-500 underline-offset-2">
          {part.text}
        </span>
      ))}
    </>
  )
}

export default function ResultExplanation({ explanation }: { explanation: Explanation | null }) {
  if (!explanation) {
    return (
      <p className="text-xs text-gray-500">
        A plain-English summary is not available for this analysis. Use the results below.
      </p>
    )
  }
  return (
    <section aria-label="Plain-English summary" className="space-y-2 rounded-lg border border-gray-700 p-4 text-sm text-gray-300">
      <h3 className="font-medium text-white">Plain-English summary</h3>
      {explanation.paragraphs.map((parts, i) => <p key={i}><Sentence parts={parts} /></p>)}
      <ul className="list-disc space-y-1 pl-5 text-xs text-gray-400">
        {explanation.caveats.map((parts, i) => <li key={i}><Sentence parts={parts} /></li>)}
      </ul>
      <p className="text-xs text-gray-500">
        Generated from fixed rules, not AI. Every underlined number comes directly from the results; hover to see its source.
      </p>
    </section>
  )
}
