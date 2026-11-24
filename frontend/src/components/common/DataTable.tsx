import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import styles from './DataTable.module.css';

export type SortDirection = 'asc' | 'desc';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
  className?: string;
  width?: string;
  minWidth?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string | number;
  emptyState?: React.ReactNode;
  className?: string;
  maxHeight?: number;
  stickyHeader?: boolean;
  virtualization?: boolean;
  rowHeight?: number;
  selectedRowKeys?: Array<string | number>;
  onRowSelect?: (row: T) => void;
  onRowClick?: (row: T) => void;
  onSort?: (key: string, direction: SortDirection) => void;
  /** Optional native table caption; supplies the table's accessible name. */
  caption?: string;
  /** Controlled sort state. When omitted, sorting is managed internally. */
  sortKey?: string | null;
  sortDirection?: SortDirection;
  rowClassName?: (row: T) => string;
  getRowTestId?: (row: T) => string;
}

function getCellValue<T>(row: T, key: string): string | number | boolean | null {
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

function sortRows<T>(rows: T[], key: string | null, direction: SortDirection): T[] {
  if (!key) return rows;

  return [...rows].sort((left, right) => {
    const leftValue = getCellValue(left, key);
    const rightValue = getCellValue(right, key);

    if (leftValue == null && rightValue == null) return 0;
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;

    if (leftValue === rightValue) return 0;
    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return direction === 'asc' ? leftValue - rightValue : rightValue - leftValue;
    }

    const leftString = String(leftValue).toLowerCase();
    const rightString = String(rightValue).toLowerCase();
    return direction === 'asc'
      ? leftString.localeCompare(rightString)
      : rightString.localeCompare(leftString);
  });
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  emptyState,
  className,
  maxHeight = 480,
  stickyHeader = true,
  virtualization = false,
  rowHeight = 48,
  selectedRowKeys = [],
  onRowSelect,
  onRowClick,
  onSort,
  caption,
  sortKey,
  sortDirection,
  rowClassName,
  getRowTestId,
}: DataTableProps<T>) {
  const [internalSortKey, setInternalSortKey] = useState<string | null>(null);
  const [internalSortDirection, setInternalSortDirection] = useState<SortDirection>('asc');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [activeRowIndex, setActiveRowIndex] = useState(0);

  const effectiveSortKey = sortKey !== undefined ? sortKey : internalSortKey;
  const effectiveSortDirection = sortDirection ?? internalSortDirection;

  useEffect(() => {
    if (sortKey === undefined) return;
    setInternalSortKey(sortKey);
    setInternalSortDirection(sortDirection ?? 'asc');
  }, [sortKey, sortDirection]);

  const sortedRows = useMemo(
    () => sortRows(rows, effectiveSortKey, effectiveSortDirection),
    [rows, effectiveSortKey, effectiveSortDirection]
  );

  const itemCount = sortedRows.length;
  const overscan = 6;
  const startIndex = virtualization ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan) : 0;
  const endIndex = virtualization
    ? Math.min(itemCount, Math.ceil((scrollTop + maxHeight) / rowHeight) + overscan)
    : itemCount;
  const visibleRows = virtualization ? sortedRows.slice(startIndex, endIndex) : sortedRows;

  useEffect(() => {
    setActiveRowIndex((current) => Math.min(current, Math.max(visibleRows.length - 1, 0)));
    rowRefs.current = rowRefs.current.slice(0, visibleRows.length);
  }, [visibleRows.length]);

  const handleSelect = (_key: string | number, row: T) => {
    if (onRowSelect) onRowSelect(row);
  };

  const handleSort = (column: DataTableColumn<T>) => {
    if (!column.sortable) return;
    const nextKey = column.key;
    let nextDirection: SortDirection = 'asc';

    if (effectiveSortKey === nextKey) {
      nextDirection = effectiveSortDirection === 'asc' ? 'desc' : 'asc';
    }

    setInternalSortKey(nextKey);
    setInternalSortDirection(nextDirection);
    if (onSort) {
      onSort(nextKey, nextDirection);
    }
  };

  const focusRow = (index: number) => {
    const nextIndex = Math.min(Math.max(index, 0), visibleRows.length - 1);
    setActiveRowIndex(nextIndex);
    rowRefs.current[nextIndex]?.focus();
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, index: number, row: T) => {
    if (event.target !== event.currentTarget) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(visibleRows.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (onRowClick) {
          event.preventDefault();
          onRowClick(row);
        }
        break;
    }
  };

  if (rows.length === 0) {
    return <div className={styles.emptyWrap}>{emptyState ?? <span>No rows available.</span>}</div>;
  }

  return (
    <div className={`${styles.wrapper} ${className ?? ''}`} style={{ maxHeight }}>
      <div
        ref={scrollRef}
        className={styles.viewport}
        style={virtualization ? { maxHeight, overflowY: 'auto' } : undefined}
        onScroll={virtualization ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
      >
        <table className={styles.table}>
          {caption && <caption className={styles.caption}>{caption}</caption>}
          <thead className={stickyHeader ? styles.stickyHeader : ''}>
            <tr>
              {onRowSelect && <th scope="col" className={styles.selectionCell} aria-label="Row selection" />}
              {columns.map((column) => {
                const ariaSort = column.sortable
                  ? effectiveSortKey === column.key
                    ? effectiveSortDirection === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                  : undefined;

                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={column.sortable ? styles.sortableHeader : undefined}
                    style={{ width: column.width, minWidth: column.minWidth, resize: 'horizontal' }}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        className={styles.sortButton}
                        onClick={() => handleSort(column)}
                        aria-label={`Sort by ${column.header}`}
                      >
                        <span>{column.header}</span>
                        {effectiveSortKey === column.key ? (
                          effectiveSortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                        ) : (
                          <ArrowUpDown size={12} />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => {
              const rowKey = getRowKey(row);
              const isSelected = selectedRowKeys.includes(rowKey);
              const classes = [styles.row, rowClassName ? rowClassName(row) : ''];
              if (isSelected) classes.push(styles.selectedRow);

              return (
                <tr
                  key={rowKey}
                  ref={(element) => { rowRefs.current[rowIndex] = element; }}
                  data-testid={getRowTestId ? getRowTestId(row) : `agent-row-${String(rowKey)}`}
                  className={classes.join(' ')}
                  onClick={() => onRowClick?.(row)}
                  onFocus={() => setActiveRowIndex(rowIndex)}
                  onKeyDown={(event) => handleRowKeyDown(event, rowIndex, row)}
                  tabIndex={rowIndex === activeRowIndex ? 0 : -1}
                  aria-selected={onRowSelect ? isSelected : undefined}
                >
                  {onRowSelect && (
                    <td className={styles.selectionCell}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleSelect(rowKey, row)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Select row ${String(rowKey)}`}
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={`${String(rowKey)}-${column.key}`}
                      className={column.className}
                      title={typeof getCellValue(row, column.key) === 'string' ? String(getCellValue(row, column.key)) : undefined}
                    >
                      {column.render ? column.render(row) : getCellValue(row, column.key) ?? '—'}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {virtualization && itemCount > 0 && (
        <div className={styles.virtualizationMeta}>
          Showing {Math.max(0, endIndex - startIndex)} of {itemCount} rows
        </div>
      )}
    </div>
  );
}