import React from 'react';
import { Link } from 'react-router-dom';

export const NotFoundPage: React.FC = () => {
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '60vh',
            padding: '2rem',
            textAlign: 'center',
            color: 'var(--text-primary)',
            backgroundColor: 'var(--bg-primary)'
        }}>

            <h1 style={{
                fontSize: '2.5rem',
                fontWeight: 'bold',
                marginBottom: '1rem',
                color: 'var(--text-primary)'
            }}>
            404 — Page Not Found
            </h1>

            <p style={{
                fontSize: '1rem',
                color: 'var(--text-secondary)',
                maxWidth: '480px',
                marginBottom: '2rem',
                lineHeight: '1.5'
            }}>
            The page you are looking for does not exist or has been moved.
            </p>

            <div style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                justifyContent: 'center'
            }}>

                <Link to="/dashboard" style={{
                padding: '0.6rem 1.25rem',
                borderRadius: '6px',
                backgroundColor: 'var(--accent-color, var(--primary-color, #3b82f6))',
                color: 'var(--text-primary, #ffffff)',
                fontWeight: '500',
                fontSize: '0.9rem',
                textDecoration: 'none',
                display: 'inline-block'
            }}>
            Go to Dashboard
            </Link>

            <Link to="/" style={{
                padding: '0.6rem 1.25rem',
                borderRadius: '6px',
                border: '1px solid var(--border-color, #374151)',
                backgroundColor: 'transparent',
                color: 'var(--text-primary)',
                fontWeight: '500',
                fontSize: '0.9rem',
                textDecoration: 'none',
                display: 'inline-block'
            }}>
            Go Home
            </Link>
        </div>
    </div>
    );
};

export default NotFoundPage;