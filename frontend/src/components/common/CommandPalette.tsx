import React, { useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CornerDownLeft, Search } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import styles from './CommandPalette.module.css';

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon?: LucideIcon;
  action: () => void;
  category: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
  placeholder?: string;
}

const LISTBOX_ID = 'command-palette-listbox';

/** Category display order; unknown categories fall through to the end. */
const CATEGORY_ORDER = ['navigation', 'actions', 'settings'];

const CATEGORY_LABELS: Record<string, string> = {
  navigation: 'Navigate',
  actions: 'Actions',
  settings: 'Settings',
};

interface CategoryGroup {
  category: string;
  label: string;
  startIndex: number;
  items: Command[];
}

/**
 * Lightweight fuzzy matcher. Returns a match score for `query` inside `text`
 * (higher is better) or -1 when there is no subsequence match. Consecutive
 * runs and word-start matches score higher.
 */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevIndex = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;

    if (ti === prevIndex + 1) {
      score += 3; // consecutive run
    } else if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '-') {
      score += 2; // start of a word
    } else {
      score += 1;
    }
    prevIndex = ti;
    qi++;
  }

  return qi === q.length ? score : -1;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  commands,
  placeholder = 'Search commands...',
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const overlayRef = useFocusTrap<HTMLDivElement>(isOpen);

  // Reset state every time the palette opens/closes.
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Keep the selection within bounds as the result set changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return commands;

    return commands
      .map((command) => {
        const labelScore = fuzzyScore(q, command.label);
        const categoryScore = fuzzyScore(q, command.category);

        if (labelScore < 0 && categoryScore < 0) return null;

        // Label matches rank above category-only matches.
        const score = labelScore >= 0 ? labelScore + 100 : categoryScore;
        return { command, score };
      })
      .filter((entry): entry is { command: Command; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command);
  }, [commands, query]);

  const groups = useMemo<CategoryGroup[]>(() => {
    const categories = Array.from(new Set(filtered.map((c) => c.category)));
    const ordered = [
      ...CATEGORY_ORDER.filter((cat) => categories.includes(cat)),
      ...categories.filter((cat) => !CATEGORY_ORDER.includes(cat)),
    ];

    const result: CategoryGroup[] = [];
    let startIndex = 0;
    for (const category of ordered) {
      const items = filtered.filter((c) => c.category === category);
      if (items.length === 0) continue;
      result.push({
        category,
        label: CATEGORY_LABELS[category] ?? category,
        startIndex,
        items,
      });
      startIndex += items.length;
    }
    return result;
  }, [filtered]);

  const safeIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  const executeCommand = (command: Command) => {
    command.action();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    if (filtered.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
        break;
      case 'Enter':
        e.preventDefault();
        executeCommand(filtered[safeIndex]);
        break;
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;

      e.preventDefault();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const selectedId =
    filtered.length > 0 ? `command-palette-option-${safeIndex}` : undefined;

  return (
    <div
      ref={overlayRef}
      className={styles.overlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.inputWrapper}>
          <Search size={16} className={styles.searchIcon} aria-hidden="true" />
          <input
            type="text"
            className={styles.input}
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={LISTBOX_ID}
            aria-activedescendant={selectedId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          <span className={styles.shortcutHint}>
            <kbd className={styles.keyHint}>esc</kbd>
          </span>
        </div>

        {filtered.length > 0 ? (
          <div className={styles.resultsWrapper} id={LISTBOX_ID} role="listbox" aria-label="Commands">
            {groups.map((group) => (
              <div key={group.category} className={styles.categoryGroup}>
                <div className={styles.categoryLabel}>{group.label}</div>
                {group.items.map((command, i) => {
                  const globalIndex = group.startIndex + i;
                  const Icon = command.icon;
                  return (
                    <button
                      key={command.id}
                      id={`command-palette-option-${globalIndex}`}
                      role="option"
                      aria-selected={globalIndex === safeIndex}
                      className={`${styles.resultItem} ${
                        globalIndex === safeIndex ? styles.selected : ''
                      }`}
                      onClick={() => executeCommand(command)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                    >
                      {Icon && (
                        <span className={styles.resultIcon}>
                          <Icon size={16} aria-hidden="true" />
                        </span>
                      )}
                      <span className={styles.resultContent}>
                        <span className={styles.resultTitle}>{command.label}</span>
                      </span>
                      {command.shortcut && (
                        <span className={styles.resultShortcut}>
                          <kbd className={styles.keyHint}>{command.shortcut}</kbd>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptyState}>
            <p className={styles.emptyText}>No commands found</p>
            <p className={styles.emptySubtext}>Try a different search</p>
          </div>
        )}

        <div className={styles.footer}>
          <span className={styles.shortcutHint}>
            <kbd className={styles.keyHint}>↑</kbd>
            <kbd className={styles.keyHint}>↓</kbd>
            navigate
          </span>
          <span className={styles.shortcutHint}>
            <kbd className={styles.keyHint}>
              <CornerDownLeft size={10} aria-hidden="true" />
            </kbd>
            select
          </span>
          <span className={styles.shortcutHint}>
            <kbd className={styles.keyHint}>esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
};
