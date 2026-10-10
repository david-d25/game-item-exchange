import { Link } from 'react-router'
import { REPOSITORY_URL } from '../components/Footer'
import { ArrowUpRightIcon } from '../components/icons'
import { FlowDiagram } from './FlowDiagram'

export function AboutPage() {
  return (
    <div className="page about-page">
      <header className="about-head">
        <h1>How this exchange works</h1>
        <p className="lede">
          Game Item Exchange is a portfolio project: a working exchange where items from games are traded through an
          order book. The credits are play money. Bots trade around the clock, so the book and the tape keep moving,
          and anyone can join them with a guest account.
        </p>
        <p className="about-links">
          <a className="button button-secondary" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
            Source code on GitHub <ArrowUpRightIcon size={14} />
          </a>
          <Link className="button button-ghost" to="/">
            Open the markets
          </Link>
        </p>
      </header>

      <section className="about-section" aria-labelledby="flow-title">
        <h2 id="flow-title">The path of an order</h2>
        <FlowDiagram />
        <ol className="steps about-steps">
          <li>
            <b>Core accepts the order.</b> In one Postgres transaction it checks the order, reserves the credits for a
            buy or the items for a sell, and writes an outbox row next to the order. Either all of it happens or none
            of it does.
          </li>
          <li>
            <b>The relay publishes it to Kafka.</b> Outbox rows go to the <code>orders</code> topic, partitioned by
            market, so the orders of one market are always read in the order they were accepted.
          </li>
          <li>
            <b>The matcher matches it.</b> Each partition is owned by a single thread that keeps the order books in
            memory, matches the new order and publishes trades and order updates to <code>match-results</code>. One
            thread per book means no locks on the hot path.
          </li>
          <li>
            <b>Core settles the results exactly once.</b> Every trade moves credits and items through a double-entry
            ledger, where each transfer is a debit and a credit that sum to zero. The buyer and the seller get a
            notification.
          </li>
        </ol>
      </section>

      <section className="about-section" aria-labelledby="details-title">
        <h2 id="details-title">Details</h2>
        <dl className="facts">
          <div>
            <dt>Price-time priority</dt>
            <dd>
              The best price trades first. At the same price, the order that came first does. A trade happens at the
              price of the order that was already resting in the book.
            </dd>
          </div>
          <div>
            <dt>Time in force</dt>
            <dd>
              <b>GTC</b> waits in the book until it fills or you cancel it. <b>IOC</b> fills what it can right away and
              cancels the rest. <b>FOK</b> fills completely right away or not at all.
            </dd>
          </div>
          <div>
            <dt>Crash recovery</dt>
            <dd>
              The matcher has no database. When it restarts, it rebuilds its order books by replaying the{' '}
              <code>orders</code> topic from Kafka, and ends up in exactly the state it was in.
            </dd>
          </div>
          <div>
            <dt>Retries are safe</dt>
            <dd>
              Each order carries a client order id. Sending the same order again returns the original instead of
              placing a second one.
            </dd>
          </div>
          <div>
            <dt>Infrastructure</dt>
            <dd>
              Kubernetes. This public instance runs on k3s on a small server shared with other projects, one
              instance of each service and a single Kafka broker. The development cluster runs the same manifests
              at full size: replicas that split the work, Kafka managed by Strimzi, Prometheus and Grafana.
            </dd>
          </div>
          <div>
            <dt>Stack</dt>
            <dd>
              Kotlin and Spring Boot for core, a plain Kotlin process for the matcher, Postgres, Kafka. This site is
              React and TypeScript served by nginx, which is also the gateway in front of core.
            </dd>
          </div>
        </dl>
      </section>

      <p className="about-credit muted">
        Price charts use{' '}
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts
        </a>
        .
      </p>
    </div>
  )
}
