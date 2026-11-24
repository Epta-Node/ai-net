import { useEffect } from "react";
import { useTranslation, Trans } from "react-i18next";
import { RotateCw, X } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { agentFilterSchema, type AgentFilterValues } from "../../schemas/agent";
import type { AgentFilters, StatusFilter } from "../../utils/agentRegistry";
import styles from "./AgentFilterBar.module.css";

interface AgentFilterBarProps {
  filters: AgentFilters;
  /** All capabilities available across the dataset. */
  availableCapabilities: string[];
  /** [min, max] price across the dataset, used to bound the slider. */
  priceDomain: [number, number];
  onChange: (next: Partial<AgentFilters>) => void;
  onReset: () => void;
  onRefresh: () => void;
}

export function AgentFilterBar({
  filters,
  availableCapabilities,
  priceDomain,
  onChange,
  onReset,
  onRefresh,
}: AgentFilterBarProps) {
  const { t } = useTranslation();
  const {
    watch,
    setValue,
    trigger,
    reset,
    formState: { errors },
  } = useForm<AgentFilterValues>({
    mode: "onBlur",
    reValidateMode: "onBlur",
    resolver: zodResolver(agentFilterSchema),
    defaultValues: filters,
  });
  const currentFilters = watch();

  useEffect(() => {
    reset(filters);
  }, [filters, reset]);

  const updateFilter = <Key extends keyof AgentFilterValues>(
    key: Key,
    value: AgentFilterValues[Key],
    validateImmediately = true,
  ) => {
    setValue(key, value, { shouldDirty: true, shouldTouch: true });
    if (!validateImmediately) return;
    void trigger().then((valid) => {
      if (valid) onChange({ [key]: value } as Partial<AgentFilters>);
    });
  };

  // Shares the agent.status.* keys with the table and the detail modal, so the
  // filter labels and the status badges can never drift apart.
  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: "all", label: t("agent.filters.all") },
    { value: "active", label: t("agent.status.active") },
    { value: "inactive", label: t("agent.status.inactive") },
  ];

  const [domainMin, domainMax] = priceDomain;
  const effectiveMax = currentFilters.priceMax ?? domainMax;

  const toggleCapability = (cap: string) => {
    const selected = currentFilters.capabilities.includes(cap);
    updateFilter(
      "capabilities",
      selected
        ? currentFilters.capabilities.filter((c) => c !== cap)
        : [...currentFilters.capabilities, cap],
    );
  };

  const hasActiveFilters =
    currentFilters.capabilities.length > 0 ||
    currentFilters.priceMin != null ||
    currentFilters.priceMax != null ||
    currentFilters.status !== "all" ||
    currentFilters.sortKey != null;

  return (
    <div className={styles.bar}>
      <div className={styles.group}>
        <span className={styles.groupLabel}>{t("common.capabilities")}</span>
        <div
          className={styles.capList}
          role="group"
          aria-label={t("a11y.filterByCapability")}
        >
          {availableCapabilities.length === 0 ? (
            <span className={styles.muted}>{t("common.none")}</span>
          ) : (
            availableCapabilities.map((cap) => {
              const selected = currentFilters.capabilities.includes(cap);
              return (
                <button
                  key={cap}
                  type="button"
                  className={`${styles.capChip} ${selected ? styles.capChipActive : ""}`}
                  aria-pressed={selected}
                  onClick={() => toggleCapability(cap)}
                  onBlur={() => void trigger("capabilities")}
                >
                  {cap}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>
          <Trans
            i18nKey="agent.filters.maxPrice"
            values={{ price: effectiveMax.toFixed(2) }}
            components={[<strong key="price" />]}
          />
        </span>
        <input
          type="range"
          className={styles.slider}
          min={domainMin}
          max={domainMax}
          step={0.01}
          value={effectiveMax}
          aria-label={t("a11y.maximumPrice")}
          aria-invalid={Boolean(errors.priceMax)}
          aria-describedby="agent-price-error"
          disabled={domainMax <= domainMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            updateFilter("priceMax", v >= domainMax ? null : v, false);
          }}
          onBlur={() => {
            void trigger().then((valid) => {
              if (valid) onChange({ priceMax: currentFilters.priceMax });
            });
          }}
        />
        <p id="agent-price-error" className={styles.filterError} role="alert">
          {errors.priceMax?.message}
        </p>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>{t("common.status")}</span>
        <div
          className={styles.toggle}
          role="group"
          aria-label={t("a11y.filterByStatus")}
        >
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`${styles.toggleButton} ${
                currentFilters.status === opt.value
                  ? styles.toggleButtonActive
                  : ""
              }`}
              aria-pressed={currentFilters.status === opt.value}
              onClick={() => updateFilter("status", opt.value)}
              onBlur={() => void trigger("status")}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.iconAction}
          onClick={onRefresh}
          title={t("a11y.refreshNow")}
          aria-label={t("a11y.refreshNow")}
        >
          <RotateCw size={14} />
        </button>
        {hasActiveFilters && (
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => {
              reset({
                capabilities: [],
                priceMin: null,
                priceMax: null,
                status: "all",
                sortKey: null,
                sortDir: "desc",
              });
              onReset();
            }}
          >
            <X size={14} />
            {t("common.clear")}
          </button>
        )}
      </div>
    </div>
  );
}
