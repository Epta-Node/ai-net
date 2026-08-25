import React from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, Link } from 'react-router-dom'
import './Breadcrumb.css'

const Breadcrumb: React.FC = () => {
  const { t } = useTranslation()
  const location = useLocation()
  const pathnames = location.pathname.split('/').filter(Boolean)

  const getBreadcrumbLabel = (path: string, index: number) => {
    const fullPath = '/' + pathnames.slice(0, index + 1).join('/')
    
    switch (fullPath) {
      case '/': return t('nav.dashboard')
      case '/tasks': return t('nav.tasks')
      case '/tasks/new': return t('nav.newTask')
      case '/agents': return t('nav.agents')
      case '/wallet': return t('nav.wallet')
      default:
        if (fullPath.startsWith('/tasks/') && pathnames.length > 1) {
          return t('nav.taskWithId', { id: pathnames[1] })
        }
        return path.charAt(0).toUpperCase() + path.slice(1)
    }
  }

  if (pathnames.length === 0) {
    return null
  }

  return (
    <nav className="breadcrumb" aria-label={t('a11y.breadcrumb')}>
      <ol>
        <li>
          <Link to="/">{t('nav.dashboard')}</Link>
        </li>
        {pathnames.map((path, index) => {
          const fullPath = '/' + pathnames.slice(0, index + 1).join('/')
          const isLast = index === pathnames.length - 1
          const label = getBreadcrumbLabel(path, index)

          return (
            <li key={fullPath}>
              <span className="separator">/</span>
              {isLast ? (
                <span aria-current="page">{label}</span>
              ) : (
                <Link to={fullPath}>{label}</Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export default Breadcrumb
