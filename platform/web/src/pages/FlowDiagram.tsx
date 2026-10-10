// The path of an order through the system, drawn twice: a loop for wide screens and a column for phones.

interface FlowNode {
  title: string
  lines: string[]
  step?: number
  kind: 'client' | 'service' | 'store' | 'topic'
}

const NODES: FlowNode[] = [
  { title: 'Your browser', lines: ['Sends the order with', 'a client order id'], kind: 'client' },
  { title: 'Core API', lines: ['Validates the order and', 'reserves credits or items'], step: 1, kind: 'service' },
  { title: 'Postgres', lines: ['Order, reservation and', 'outbox row: one transaction'], kind: 'store' },
  { title: 'Outbox relay', lines: ['Publishes new rows', 'in commit order'], step: 2, kind: 'service' },
  { title: 'Kafka: orders', lines: ['Partitioned by market,', 'kept for replay'], kind: 'topic' },
  { title: 'Matcher', lines: ['One thread per partition,', 'order books in memory'], step: 3, kind: 'service' },
  { title: 'Kafka: match-results', lines: ['Trades, resting and', 'closed orders'], kind: 'topic' },
  { title: 'Core settlement', lines: ['Applies each result once', 'to a double-entry ledger'], step: 4, kind: 'service' },
]

const H = 70

function Node({ node, x, y, w }: { node: FlowNode; x: number; y: number; w: number }) {
  return (
    <g transform={`translate(${x} ${y})`} className={`flow-node flow-${node.kind}`}>
      <rect width={w} height={H} rx={node.kind === 'topic' ? 2 : 6} />
      {node.kind === 'topic' && <path d={`M${w - 14} 8v${H - 16}M${w - 22} 8v${H - 16}M${w - 30} 8v${H - 16}`} className="flow-partition" />}
      <text x={14} y={25} className="flow-title">
        {node.title}
      </text>
      {node.lines.map((line, i) => (
        <text key={i} x={14} y={44 + i * 15} className="flow-line">
          {line}
        </text>
      ))}
      {node.step != null && (
        <g transform={`translate(${w} 0)`}>
          <circle r={10} className="flow-step" />
          <text y={4} textAnchor="middle" className="flow-step-number">
            {node.step}
          </text>
        </g>
      )}
    </g>
  )
}

function ArrowDefs({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1 9 5 0 9Z" className="flow-arrowhead" />
      </marker>
    </defs>
  )
}

const DESCRIPTION =
  'An order goes from your browser to core, which stores it together with an outbox row in Postgres. ' +
  'The outbox relay publishes it to the Kafka topic orders, the matcher matches it and publishes the results ' +
  'to match-results, and core settles them into the ledger. Balances and notifications go back to the browser.'

export function FlowDiagram() {
  // Wide: a loop. Top row left to right, bottom row right to left, and the fill comes back to the browser.
  const w = 196
  const gap = 38
  const left = 14
  const top = 18
  const bottom = 196
  const xs = [0, 1, 2, 3].map((i) => left + i * (w + gap))
  const placed = NODES.map((node, i) => ({ node, x: i < 4 ? xs[i]! : xs[7 - i]!, y: i < 4 ? top : bottom }))
  const width = left * 2 + 4 * w + 3 * gap
  const height = bottom + H + 14
  const midY = (top + H + bottom) / 2

  // Narrow: one column
  const nw = 300
  const pitch = H + 28

  return (
    <figure className="flow">
      <svg className="flow-wide" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={DESCRIPTION}>
        <ArrowDefs id="flow-arrow" />
        {[0, 1, 2].map((i) => (
          <line key={`t${i}`} x1={xs[i]! + w + 4} y1={top + H / 2} x2={xs[i + 1]! - 4} y2={top + H / 2}
            className="flow-edge" markerEnd="url(#flow-arrow)" />
        ))}
        <line x1={xs[3]! + w / 2} y1={top + H + 4} x2={xs[3]! + w / 2} y2={bottom - 4}
          className="flow-edge" markerEnd="url(#flow-arrow)" />
        <text x={xs[3]! + w / 2 - 10} y={midY + 4} textAnchor="end" className="flow-edge-label">at least once</text>
        {[3, 2, 1].map((i) => (
          <line key={`b${i}`} x1={xs[i]! - 4} y1={bottom + H / 2} x2={xs[i - 1]! + w + 4} y2={bottom + H / 2}
            className="flow-edge" markerEnd="url(#flow-arrow)" />
        ))}
        <line x1={xs[0]! + w / 2} y1={bottom - 4} x2={xs[0]! + w / 2} y2={top + H + 4}
          className="flow-edge flow-edge-back" markerEnd="url(#flow-arrow)" />
        <text x={xs[0]! + w / 2 + 10} y={midY + 4} className="flow-edge-label">balances, fills, notifications</text>
        {placed.map(({ node, x, y }) => (
          <Node key={node.title} node={node} x={x} y={y} w={w} />
        ))}
      </svg>

      <svg className="flow-narrow" viewBox={`0 0 ${nw + 26} ${NODES.length * pitch - 28 + 24}`} role="img"
        aria-label={DESCRIPTION}>
        <ArrowDefs id="flow-arrow-narrow" />
        {NODES.slice(0, -1).map((_, i) => (
          <line key={i} x1={40} y1={12 + i * pitch + H + 4} x2={40} y2={12 + (i + 1) * pitch - 4}
            className="flow-edge" markerEnd="url(#flow-arrow-narrow)" />
        ))}
        {NODES.map((node, i) => (
          <Node key={node.title} node={node} x={12} y={12 + i * pitch} w={nw} />
        ))}
      </svg>
      <figcaption>
        The numbers match the steps below. The relay may publish a message twice; readers drop the duplicate, so every
        result is settled exactly once.
      </figcaption>
    </figure>
  )
}
