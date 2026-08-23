'use client';

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  /** Label for the error message (e.g. "Ranking Outlet", "Trend Chart") */
  label?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary — prevents one crashed component from blanking the entire dashboard.
 * Wrap each card/section so a render error in one doesn't take down the rest.
 *
 * Usage:
 * ```tsx
 * <ErrorBoundary label="Historical Z-Score">
 *   <HistoricalZScoreCard data={data} />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500 mb-3" />
          <p className="text-sm font-medium text-foreground">
            {this.props.label ? `${this.props.label} gagal dimuat` : 'Komponen gagal dimuat'}
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md">
            {this.state.error?.message || 'Terjadi kesalahan saat merender komponen ini.'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 h-7 text-xs"
            onClick={this.handleReset}
          >
            Coba lagi
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
