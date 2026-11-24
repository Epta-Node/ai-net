import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FormField } from './FormField';

describe('FormField', () => {
  it('renders correctly with label', () => {
    render(<FormField label="Test Label" name="test" />);
    expect(screen.getByLabelText('Test Label')).toBeInTheDocument();
  });

  it('shows error state when touched and invalid', () => {
    render(<FormField label="Test" name="test" error="Required field" isTouched={true} />);
    
    const input = screen.getByLabelText('Test');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveStyle({ border: '1px solid #b91c1c' });
    
    const errorMessage = screen.getByText('Required field');
    expect(errorMessage).toBeInTheDocument();
    
    // Check if error is within an aria-live region
    const alert = errorMessage.closest('[aria-live="polite"]');
    expect(alert).toBeInTheDocument();
  });

  it('shows valid state when touched and valid', () => {
    render(<FormField label="Test" name="test" isTouched={true} />);
    
    const input = screen.getByLabelText('Test');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input).toHaveStyle({ border: '1px solid #16a34a' });
  });

  it('does not show validation states when untouched', () => {
    render(<FormField label="Test" name="test" isTouched={false} error="Error" />);
    
    const input = screen.getByLabelText('Test');
    // Assuming default border color if untouched, testing for not having error color
    expect(input).not.toHaveStyle({ border: '1px solid #b91c1c' });
    expect(input).not.toHaveStyle({ border: '1px solid #16a34a' });
    expect(screen.queryByText('Error')).not.toBeInTheDocument();
  });
});
