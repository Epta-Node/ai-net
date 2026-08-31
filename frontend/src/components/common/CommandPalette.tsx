import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './CommandPalette.module.css';

export type CommandPaletteCategory = 'action' | 'page' | 'agent' | 'task' | 'recent';

export interface CommandPaletteResult {
  id: string;
  title: string;
  subtitle?: string;
  category: CommandPaletteCategory;
  action: () => void;
  metadata?: string;
  /**
   * Indices into `title` that the query matched, for highlighting. Optional:
   * results without it render as plain text.
   */
  titleMatches?: number[];
  /** Keyboard hint shown on the right, e.g. `Ctrl K`. */
  shortcut?: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (query: string) => Promise<CommandPaletteResult[]>;
  placeholder?: string;
  recentSearches?: string[];
  onRecentSearchClick?: (query: string) => void;
}

/** A result plus the palette's own behavioural flags. */
type PaletteItem = CommandPaletteResult & {
  /** Selecting this item refines the search rather than navigating away. */
  keepOpen?: boolean;
};

/** Order categories appear in. Actions first: they are what the user came to do. */
const CATEGORY_ORDER: CommandPaletteCategory[] = ['action', 'page', 'agent', 'task', 'recent'];

const CATEGORY_LABEL_KEYS: Record<CommandPaletteCategory, string> = {
  action: 'palette.category.actions',
  page: 'palette.category.pages',
  agent: 'palette.category.agents',
  task: 'palette.category.tasks',
  recent: 'palette.category.recent',
};

const DEBOUNCE_MS = 300;

/**
 * Renders `title` with the fuzzy-matched characters emphasised.
 *
 * Falls back to a single text node when there is nothing to highlight, so the
 * common case stays one element in the accessibility tree (and one node for
 * text queries in tests) rather than a string shattered into spans.
 */
const HighlightedTitle: React.FC<{ title: string; matches?: number[] }> = ({ title, matches }) => {
  if (!matches || matches.length === 0) return <>{title}</>;

  const matched = new Set(matches);
  const segments: { text: string; hit: boolean }[] = [];

  for (let i = 0; i < title.length; i++) {
    const hit = matched.has(i);
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) {
      last.text += title[i];
    } else {
      segments.push({ text: title[i], hit });
    }
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.hit ? (
          <mark key={index} className={styles.highlight}>
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  );
};

/**
 * Keyboard-first command palette.
 *
 * The palette is a pure renderer: matching and ranking happen in
 * `useCommandPalette`, which hands back results already ordered. That keeps the
 * fuzzy logic testable on its own and lets this component stay about
 * presentation and keyboard handling.
 *
 * Every action is reachable without the mouse — arrows and Tab move the
 * selection, Home/End jump to the ends, Enter runs, Escape dismisses. Focus
 * never leaves the input, so the listbox is driven through
 * `aria-activedescendant` rather than by moving DOM focus around.
 */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onSearch,
  placeholder,
  recentSearches = [],
  onRecentSearchClick,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [searchResults, setSearchResults] = React.useState<CommandPaletteResult[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolvedPlaceholder = placeholder ?? t('palette.placeholder');

  React.useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (!query.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    timeoutRef.current = setTimeout(async () => {
      try {
        const result = await onSearch(query);
        setSearchResults(result);
      } catch {
        setSearchResults([]);
      }
      setIsSearching(false);
    }, DEBOUNCE_MS);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [query, onSearch]);

  React.useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setSearchResults([]);
      setSelectedIndex(0);
    }
  }, [isOpen]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  /**
   * With no query the palette offers recent searches as shortcuts back into a
   * previous search; with a query, results already include any recent search
   * that matched, ranked alongside everything else.
   */
  const allItems: PaletteItem[] = React.useMemo(() => {
    if (query.trim()) return searchResults;
    return recentSearches.map((term) => ({
      id: `recent-${term}`,
      title: term,
      category: 'recent' as const,
      keepOpen: true,
      action: () => {
        setQuery(term);
        onRecentSearchClick?.(term);
      },
    }));
  }, [query, searchResults, recentSearches, onRecentSearchClick]);

  // A stale selection into a shorter list would run the wrong action on Enter.
  React.useEffect(() => {
    setSelectedIndex((current) => (current < allItems.length ? current : 0));
  }, [allItems]);

  const selectItem = React.useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      item.action();
      if (!item.keepOpen) onClose();
    },
    [onClose],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const count = allItems.length;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (count) setSelectedIndex((i) => (i + 1) % count);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (count) setSelectedIndex((i) => (i - 1 + count) % count);
        break;
      case 'Tab':
        // Trap Tab: the palette is modal, so Tab moves the selection instead of
        // walking focus out into the page behind it.
        e.preventDefault();
        if (count) {
          setSelectedIndex((i) => (e.shiftKey ? (i - 1 + count) % count : (i + 1) % count));
        }
        break;
      case 'Home':
        e.preventDefault();
        setSelectedIndex(0);
        break;
      case 'End':
        e.preventDefault();
        if (count) setSelectedIndex(count - 1);
        break;
      case 'Enter':
        e.preventDefault();
        selectItem(allItems[selectedIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  };

  // Keep the highlighted row visible when arrowing past the fold.
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-selected="true"]');
    // jsdom (and any non-layout environment) has no scrollIntoView; keeping the
    // row visible is a nicety, not something worth throwing over.
    if (typeof active?.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, allItems]);

  if (!isOpen) return null;

  const hasItems = allItems.length > 0;
  const activeItem = allItems[selectedIndex];
  const listboxId = 'command-palette-listbox';

  return (
    <div
      className={styles.overlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('palette.label')}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.inputWrapper}>
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            placeholder={resolvedPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-expanded={hasItems}
            aria-controls={listboxId}
            aria-activedescendant={activeItem ? `palette-option-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          <button className={styles.closeButton} onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        {isSearching && (
          <div className={styles.loadingState} role="status">
            {t('palette.loading')}
          </div>
        )}

        {!isSearching && query.trim() && !hasItems && (
          <div className={styles.emptyState} role="status">
            <div className={styles.emptyText}>{t('palette.noResults')}</div>
            <div className={styles.emptySubtext}>{t('palette.noResultsHint')}</div>
          </div>
        )}

        {!isSearching && hasItems && (
          <div className={styles.resultsWrapper} ref={listRef} id={listboxId} role="listbox">
            {CATEGORY_ORDER.map((category) => {
              const items = allItems.filter((item) => item.category === category);
              if (items.length === 0) return null;
              return (
                <div key={category} className={styles.categoryGroup} role="group">
                  <div className={styles.categoryLabel}>{t(CATEGORY_LABEL_KEYS[category])}</div>
                  {items.map((item) => {
                    const globalIndex = allItems.indexOf(item);
                    const isSelected = globalIndex === selectedIndex;
                    return (
                      <div
                        key={item.id}
                        id={`palette-option-${item.id}`}
                        role="option"
                        aria-selected={isSelected}
                        data-selected={isSelected}
                        className={`${styles.resultItem} ${isSelected ? styles.selected : ''}`}
                        onClick={() => selectItem(item)}
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
                      >
                        <span className={styles.resultContent}>
                          <span className={styles.resultTitle}>
                            <HighlightedTitle title={item.title} matches={item.titleMatches} />
                          </span>
                          {item.subtitle && (
                            <span className={styles.resultSubtitle}>{item.subtitle}</span>
                          )}
                        </span>
                        {item.metadata && (
                          <span className={styles.resultMetadata}>{item.metadata}</span>
                        )}
                        {item.shortcut && <kbd className={styles.resultShortcut}>{item.shortcut}</kbd>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.footer}>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t('palette.hint.navigate')}
          </span>
          <span>
            <kbd>↵</kbd> {t('palette.hint.select')}
          </span>
          <span>
            <kbd>esc</kbd> {t('palette.hint.close')}
          </span>
        </div>
      </div>
    </div>
  );
};
