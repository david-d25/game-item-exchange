import { useEffect } from 'react'
import { BrowserRouter, Outlet, Route, Routes, useLocation } from 'react-router'
import { DemoBanner } from './components/DemoBanner'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { AboutPage } from './pages/AboutPage'
import { MarketPage } from './pages/MarketPage'
import { MarketsPage } from './pages/MarketsPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { MarketsProvider } from './state/markets'
import { SessionProvider } from './state/session'
import { ToastProvider } from './state/toast'

// BASE_URL is `/exchange/`; the router wants it without the trailing slash
const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

export function App() {
  return (
    <BrowserRouter basename={basename}>
      <ToastProvider>
        <SessionProvider>
          <MarketsProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<MarketsPage />} />
                <Route path="markets/:marketId" element={<MarketPage />} />
                <Route path="portfolio" element={<PortfolioPage />} />
                <Route path="about" element={<AboutPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </MarketsProvider>
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  )
}

const TITLES: Record<string, string> = {
  '/': 'Markets',
  '/portfolio': 'Portfolio',
  '/about': 'About',
}

function Layout() {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo(0, 0)
    const title = TITLES[pathname]
    if (title) document.title = `${title} | Game Item Exchange`
  }, [pathname])

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <DemoBanner />
      <Header />
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
