'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { type ReactNode } from 'react';

// ============================================================
//  Animation wrappers using Framer Motion
// ============================================================

/** Fade + slide-up transition for tab content / filter change */
export function AnimatedTabContent({ children, tabKey }: { children: ReactNode; tabKey: string }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={tabKey}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -5 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/** Fade transition for analysis data refresh (filter change) */
export function AnimatedDataRefresh({ children, dataKey }: { children: ReactNode; dataKey: string }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={dataKey}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/** Stagger container for cards/sections */
export function StaggerContainer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={{
        hidden: { opacity: 0 },
        visible: {
          opacity: 1,
          transition: { staggerChildren: 0.05, delayChildren: 0.02 },
        },
      }}
    >
      {children}
    </motion.div>
  );
}

/** Stagger item — use inside StaggerContainer */
export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
      }}
    >
      {children}
    </motion.div>
  );
}

/** Skeleton pulse loader for inline loading state */
export function LoadingPulse({ message }: { message?: string }) {
  return (
    <motion.div
      className="flex items-center justify-center py-12"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <div className="flex flex-col items-center gap-3">
        <motion.div
          className="h-8 w-8 rounded-full border-2 border-muted border-t-primary"
          animate={{ rotate: 360 }}
          transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
        />
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </div>
    </motion.div>
  );
}

/** Fade-in overlay for filter change loading */
export function LoadingOverlay({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="flex flex-col items-center gap-3">
            <motion.div
              className="h-10 w-10 rounded-full border-2 border-muted border-t-primary"
              animate={{ rotate: 360 }}
              transition={{ duration: 0.6, repeat: Infinity, ease: 'linear' }}
            />
            <p className="text-sm text-muted-foreground">Memuat data analisis...</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
