import { useMemo, type ComponentProps } from 'react';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import AgentFilters from './AgentFilters';
import { AgentFilterBar } from './AgentFilterBar';
import {
  filtersFromSearchParams,
  filtersToSearchParams,
  type AgentFilters as RegistryFilters,
} from '../../utils/agentRegistry';

type FiltersProps = ComponentProps<typeof AgentFilters>;

const CAPABILITIES = ['research', 'coding', 'audit'];

function makeProps(overrides: Partial<FiltersProps> = {}): FiltersProps {
  return {
    searchQuery: '',
    onSearchChange: vi.fn(),
    selectedCapabilities: [],
    onToggleCapability: vi.fn(),
    availableCapabilities: CAPABILITIES,
    sortBy: 'relevance',
    onSortChange: vi.fn(),
    resultCount: CAPABILITIES.length,
    onReset: vi.fn(),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

/**
 * Uses the same URL query-param persistence as AgentsPage: filters are derived
 * from the URL, every change is serialized back to it, and a remount rehydrates
 * from that URL. No storage mock is needed because nothing touches storage.
 */
function UrlFilterHarness() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams]);

  const updateFilters = (next: Partial<RegistryFilters>) => {
    setSearchParams(filtersToSearchParams({ ...filters, ...next }), { replace: true });
  };

  const toggleCapability = (cap: string) => {
    updateFilters({
      capabilities: filters.capabilities.includes(cap)
        ? filters.capabilities.filter((value) => value !== cap)
        : [...filters.capabilities, cap],
    });
  };

  return (
    <>
      <div role="region" aria-label="AgentFilters under test">
        <AgentFilters
          searchQuery={filters.query ?? ''}
          onSearchChange={(query) => updateFilters({ query })}
          selectedCapabilities={filters.capabilities}
          onToggleCapability={toggleCapability}
          availableCapabilities={CAPABILITIES}
          sortBy={filters.sortBy ?? 'relevance'}
          onSortChange={(sortBy) => updateFilters({ sortBy })}
          resultCount={3}
          onReset={() => setSearchParams({}, { replace: true })}
        />
      </div>
      <AgentFilterBar
        filters={filters}
        availableCapabilities={CAPABILITIES}
        priceDomain={[0, 2]}
        onChange={updateFilters}
        onReset={() => setSearchParams({}, { replace: true })}
        onRefresh={() => {}}
      />
      <LocationProbe />
    </>
  );
}

function renderUrlHarness(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/agents${search}`]}>
      <UrlFilterHarness />
    </MemoryRouter>
  );
}

/** AgentFilterBar repeats the capability label, so scope queries to the unit under test. */
function filtersUnderTest() {
  return within(screen.getByRole('region', { name: 'AgentFilters under test' }));
}

describe('AgentFilters', () => {
  it('filters by agent type via the real capability values and reports the pressed state', async () => {
    const user = userEvent.setup();
    const props = makeProps();

    const { unmount } = render(<AgentFilters {...props} />);

    const group = screen.getByRole('group', { name: 'Filter by capability' });
    await user.click(within(group).getByRole('button', { name: 'research' }));

    expect(props.onToggleCapability).toHaveBeenCalledWith('research');
    // The controlled parent has not updated yet: the pill still reflects the prop.
    expect(within(group).getByRole('button', { name: 'research' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    // Controlled round-trip: after the parent accepts the filter, the pill is pressed.
    unmount();
    render(<AgentFilters {...makeProps({ selectedCapabilities: ['research'] })} />);
    expect(
      within(screen.getByRole('group', { name: 'Filter by capability' })).getByRole(
        'button',
        { name: 'research', pressed: true }
      )
    ).toBeInTheDocument();
  });

  it('handles empty and unknown capability values without rendering pills', () => {
    render(
      <AgentFilters
        {...makeProps({
          availableCapabilities: [],
          selectedCapabilities: ['unknown-capability'],
          resultCount: 0,
        })}
      />
    );

    expect(screen.queryByRole('group', { name: 'Filter by capability' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('0 agents found');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });

  it('debounces search, skips a controlled echo, and clears the query immediately', async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();

    const { rerender } = render(<AgentFilters {...makeProps({ onSearchChange })} />);
    const input = screen.getByRole('searchbox', { name: 'Search agents' });

    await user.type(input, 'codi');
    expect(onSearchChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith('codi'));

    // A parent echo of the same value must not re-emit the callback.
    rerender(<AgentFilters {...makeProps({ onSearchChange, searchQuery: 'codi' })} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(onSearchChange).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Clear search query' }));
    expect(input).toHaveValue('');
    expect(onSearchChange).toHaveBeenLastCalledWith('');
  });

  it('emits every real sort option with its exact value', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();

    render(<AgentFilters {...makeProps({ onSortChange })} />);
    const sort = screen.getByRole('combobox', { name: /sort/i });

    for (const option of ['relevance', 'price_asc', 'price_desc', 'reputation'] as const) {
      await user.selectOptions(sort, option);
    }

    expect(onSortChange.mock.calls.map(([value]) => value)).toEqual([
      'relevance',
      'price_asc',
      'price_desc',
      'reputation',
    ]);
  });

  it('shows Reset only when a filter is active and clears all filters via onReset', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();

    const { rerender } = render(<AgentFilters {...makeProps({ onReset })} />);
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();

    rerender(
      <AgentFilters
        {...makeProps({ onReset, searchQuery: 'aud', selectedCapabilities: ['audit'] })}
      />
    );
    const reset = screen.getByRole('button', { name: 'Reset' });
    await user.click(reset);

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('does not render Reset when no onReset callback is supplied', () => {
    render(
      <AgentFilters
        {...makeProps({ onReset: undefined, searchQuery: 'research', selectedCapabilities: ['research'] })}
      />
    );
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });
});

describe('AgentFilters - URL query-param persistence (parent-owned)', () => {
  it('restores combined capability and status filters after unmount and remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderUrlHarness();

    await user.click(
      filtersUnderTest().getByRole('button', { name: 'research' })
    );
    await user.click(
      within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', {
        name: 'Inactive',
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('caps=research');
    });
    expect(screen.getByTestId('location-search')).toHaveTextContent('status=inactive');

    const search = screen.getByTestId('location-search').textContent ?? '';
    expect(search).toContain('?caps=research');
    expect(search).toContain('status=inactive');

    // Persistence lives in the URL, not in AgentFilters or storage.
    unmount();
    renderUrlHarness(search);

    expect(
      filtersUnderTest().getByRole('button', { name: 'research', pressed: true })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', {
        name: 'Inactive',
        pressed: true,
      })
    ).toBeInTheDocument();
  });

  it('restores the debounced search query and sort option from the URL', async () => {
    const user = userEvent.setup();
    const { unmount } = renderUrlHarness();

    await user.type(filtersUnderTest().getByRole('searchbox', { name: 'Search agents' }), 'audit');
    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('q=audit');
    });
    await user.selectOptions(filtersUnderTest().getByRole('combobox', { name: /sort/i }), 'price_asc');
    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('sortBy=price_asc');
    });

    const search = screen.getByTestId('location-search').textContent ?? '';
    unmount();
    renderUrlHarness(search);

    expect(filtersUnderTest().getByRole('searchbox', { name: 'Search agents' })).toHaveValue('audit');
    expect(filtersUnderTest().getByRole('combobox', { name: /sort/i })).toHaveValue('price_asc');
  });

  it('normalizes empty and unknown query values to the unfiltered state', () => {
    renderUrlHarness('?caps=&status=bogus&q=&sortBy=bogus');

    expect(filtersUnderTest().getByRole('searchbox', { name: 'Search agents' })).toHaveValue('');
    expect(
      within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', {
        name: 'All',
        pressed: true,
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'research', pressed: true })).not.toBeInTheDocument();
  });

  it('clears all persisted filters back to an empty query string', async () => {
    const user = userEvent.setup();
    renderUrlHarness('?caps=research&status=inactive&sortBy=price_asc&q=research');

    expect(filtersUnderTest().getByRole('searchbox', { name: 'Search agents' })).toHaveValue('research');
    await user.click(filtersUnderTest().getByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent(''));
    expect(filtersUnderTest().getByRole('searchbox', { name: 'Search agents' })).toHaveValue('');
    expect(
      filtersUnderTest().getByRole('button', { name: 'research', pressed: false })
    ).toBeInTheDocument();
  });
});
