export const REPOSITORY_URL = 'https://github.com/david-d25/game-item-exchange'

export function Footer() {
  return (
    <footer className="site-footer">
      <p>Game Item Exchange is a portfolio project. Nothing here is real money.</p>
      <p className="site-footer-links">
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">
          Charts by TradingView Lightweight Charts
        </a>
      </p>
    </footer>
  )
}
