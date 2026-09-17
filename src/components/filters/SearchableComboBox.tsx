'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface ComboOption {
  value: string;
  label: string;
  description?: string;
}

interface SearchableComboBoxProps {
  options: ComboOption[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  allOptionLabel?: string; // if provided, show "All X" option at top
  className?: string;
  disabled?: boolean;
  buttonClassName?: string;
  // FIX (BUG-FE-7): aria-label for screen reader accessibility.
  // Without this, the combobox's accessible name is just the visible text
  // (e.g. "BDG"), so screen readers don't announce the field's purpose.
  ariaLabel?: string;
}

export function SearchableComboBox({
  options,
  value,
  onValueChange,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  // P23 D1: default empty text was English ('No results found.') in an
  // all-Indonesian UI (all callers pass their own 'X tidak ditemukan.').
  emptyText = 'Tidak ada hasil.',
  allOptionLabel,
  className,
  disabled,
  buttonClassName,
  ariaLabel,
}: SearchableComboBoxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  // Determine current selection label
  const isAll = value === null || value === 'all' || value === '';
  const current = options.find((o) => o.value === value);
  const currentLabel = isAll ? (allOptionLabel || placeholder) : (current?.label || placeholder);

  // Filter options by search
  const filtered = React.useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter((o) =>
      o.label.toLowerCase().includes(q) ||
      (o.description?.toLowerCase().includes(q) ?? false) ||
      o.value.toLowerCase().includes(q)
    );
  }, [options, search]);

  function handleSelect(val: string) {
    if (val === '__all__') {
      onValueChange(null);
    } else {
      onValueChange(val);
    }
    setOpen(false);
    setSearch('');
  }

  return (
    <Popover open={open} onOpenChange={(v) => {
      setOpen(v);
      // BUG FIX #004: Clear search when popover closes
      if (!v) setSearch('');
    }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel || placeholder}
          disabled={disabled}
          className={cn('justify-between font-normal h-8 text-xs', buttonClassName)}
        >
          <span className={cn('truncate', isAll && 'text-muted-foreground')}>
            {currentLabel}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50 ml-2" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0" align="start">
        <Command shouldFilter={false}>
          <div className="flex items-center border-b px-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <CommandInput
              placeholder={searchPlaceholder}
              value={search}
              onValueChange={setSearch}
              className="h-8 text-xs"
            />
          </div>
          <CommandList className="max-h-[280px]">
            {/* FIX (BUG-EDGE-8): removed duplicate CommandEmpty — was rendered both
                here (inside CommandList) AND inside CommandGroup when filtered.length === 0.
                The one inside CommandGroup was conditional on `search` being non-empty,
                so it only showed when searching. This one shows when the options list
                is genuinely empty (no options to filter). Keeping just this one. */}
            <CommandEmpty className="text-xs py-3">{emptyText}</CommandEmpty>
            {allOptionLabel && (
              <CommandGroup heading="">
                <CommandItem
                  value="__all__"
                  onSelect={() => handleSelect('__all__')}
                  className="text-xs cursor-pointer"
                >
                  <Check className={cn('h-3.5 w-3.5', isAll ? 'opacity-100' : 'opacity-0')} />
                  <span className="font-medium text-muted-foreground">{allOptionLabel}</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {filtered.map((option) => {
                const isSelected = option.value === value;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => handleSelect(option.value)}
                    className="text-xs cursor-pointer"
                  >
                    <Check className={cn('h-3.5 w-3.5', isSelected ? 'opacity-100' : 'opacity-0')} />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="truncate">{option.label}</span>
                      {option.description && (
                        <span className="text-[11px] text-muted-foreground truncate">{option.description}</span>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
              {filtered.length === 0 && search && (
                <div className="text-xs py-3 text-center text-muted-foreground">{emptyText}</div>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
