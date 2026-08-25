import React from 'react';
import styles from './CommandPalette.module.css';

export interface CommandPaletteResult {
  id: string;
  title: string;
  subtitle?: string;
  category: 'page' | 'agent' | 'task' | 'recent';
  action: () => void;
  metadata?: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (query: string) => Promise<CommandPaletteResult[]>;
  placeholder?: string;
  recentSearches?: string[];
  onRecentSearchClick?: (query: string) => void;
}

type PaletteItem = {
  id: string;
  title: string;
  category: 'page' | 'agent' | 'task' | 'recent';
  action: () => void;
  subtitle?: string;
  metadata?: string;
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onSearch,
  placeholder = 'Search agents, tasks, or pages...',
  recentSearches = [],
  onRecentSearchClick,
}) => {
  const [query, setQuery] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [searchResults, setSearchResults] = React.useState<CommandPaletteResult[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

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
    }, 300);
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const items = query.trim() ? searchResults : recentSearches.map((s) => ({
      id: s,
      title: s,
      category: 'recent' as const,
      action: () => onRecentSearchClick?.(s),
    }));
    if (items.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        break;
      case 'Enter':
        e.preventDefault();
        items[selectedIndex]?.action();
        onClose();
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  };

  const allItems: PaletteItem[] = query.trim()
    ? searchResults
    : recentSearches.map((s) => ({
        id: s,
        title: s,
        category: 'recent' as const,
        action: () => onRecentSearchClick?.(s),
      }));

  if (!isOpen) return null;

  const hasItems = allItems.length > 0;

  const categories = query.trim()
    ? ['page', 'agent', 'task']
    : ['recent'];

  const categoryLabels: Record<string, string> = {
    page: 'Pages',
    agent: 'Agents',
    task: 'Tasks',
    recent: 'Recent Searches',
  };

  const getItemsForCategory = (category: string) => {
    return allItems.filter(item => item.category === category);
  };

  return (
    <div className={styles.overlay} onClick={onClose} role='dialog' aria-modal='true' aria-label='Command palette'>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.inputWrapper}>
          <input
            ref={inputRef}
            type='text'
            className={styles.input}
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className={styles.closeButton} onClick={onClose}>✕</button>
        </div>
        {isSearching && <div>Loading...</div>}
        {!isSearching && query.trim() && allItems.length === 0 && (
          <div>
            <div>No results found</div>
            <div>Try adjusting your search</div>
          </div>
        )}
        {!isSearching && hasItems && (
          <div>
            {categories.map((cat) => {
              const items = getItemsForCategory(cat);
              if (items.length === 0) return null;
              return (
                <div key={cat}>
                  <div>{categoryLabels[cat]}</div>
                  {items.map((item) => {
                    const globalIndex = allItems.indexOf(item);
                    return (
                      <button
                        key={item.id}
                        className={globalIndex === selectedIndex ? 'selected' : ''}
                        onClick={() => { item.action(); onClose(); }}
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
                      >
                        {item.title}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
