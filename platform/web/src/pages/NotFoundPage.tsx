import { Link } from 'react-router'

export function NotFoundPage({
  title = 'Page not found',
  text = 'There is nothing at this address.',
}: {
  title?: string
  text?: string
}) {
  return (
    <div className="page narrow-page not-found">
      <h1>{title}</h1>
      <p>{text}</p>
      <p>
        <Link to="/" className="button button-secondary">
          Go to markets
        </Link>
      </p>
    </div>
  )
}
