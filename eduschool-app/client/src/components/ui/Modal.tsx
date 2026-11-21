import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useBackButtonClose } from '../../hooks/useBackButtonClose';

// ─── Base Modal ───────────────────────────────────────────────────────────────

// Wraps DialogPrimitive.Root (instead of re-exporting it directly) so every
// modal built on <Modal> inherits back-button-closes-modal behavior for
// free, without each of the ~15 call sites needing its own wiring. Every
// current usage passes `open`/`onOpenChange` explicitly (controlled), which
// this depends on — see useBackButtonClose.ts for the history bookkeeping.
const Modal = ({
  open,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) => {
  useBackButtonClose(!!open, () => onOpenChange?.(false));
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} />;
};
Modal.displayName = 'Modal';
const ModalTrigger = DialogPrimitive.Trigger;
const ModalClose = DialogPrimitive.Close;

// Inline zIndex guarantees the overlay sits above all schedule overlays (SlotPanel z:200,
// ManagementOverlay z:300, menuDropdown z:999) regardless of Tailwind CSS compilation state.
const MODAL_Z_OVERLAY = 1000;
const MODAL_Z_CONTENT = 1001;

const ModalOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, style, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    style={{ ...style, zIndex: MODAL_Z_OVERLAY }}
    className={cn(
      'fixed inset-0 bg-black/40',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
ModalOverlay.displayName = 'ModalOverlay';

interface ModalContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  showClose?: boolean;
}

const ModalContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>(({ className, children, showClose = true, style, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <ModalOverlay />
    <DialogPrimitive.Content
      ref={ref}
      style={{ ...style, zIndex: MODAL_Z_CONTENT }}
      className={cn(
        'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
        'w-full max-w-md bg-white rounded-xl border border-border shadow-xl',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'duration-200 outline-none overflow-y-auto overflow-x-hidden',
        // Cap height so the sheet scrolls (and stays above the on-screen keyboard) instead of overflowing
        'max-h-[90dvh]',
        // Mobile: bottom sheet below sm, with safe-area inset for the home indicator
        'sm:translate-y-[-50%]',
        'max-sm:bottom-0 max-sm:left-0 max-sm:top-auto max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-xl max-sm:max-w-full max-sm:pb-[env(safe-area-inset-bottom)]',
        className
      )}
      {...props}
    >
      {children}
      {showClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 p-2 rounded-sm text-textSecondary hover:bg-surface hover:text-textPrimary transition focus:outline-none focus:ring-2 focus:ring-primary/20">
          <X className="w-4 h-4" />
          <span className="sr-only">Закрыть</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
ModalContent.displayName = 'ModalContent';

const ModalHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-6 pt-6 pb-0', className)} {...props} />
);

const ModalBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-6 py-5', className)} {...props} />
);

const ModalFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex gap-3 bg-surface px-6 py-4 border-t border-border', className)} {...props} />
);

const ModalTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-heading-lg font-semibold text-textPrimary leading-tight', className)}
    {...props}
  />
));
ModalTitle.displayName = 'ModalTitle';

const ModalDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-body-sm text-textSecondary leading-relaxed mt-1.5', className)}
    {...props}
  />
));
ModalDescription.displayName = 'ModalDescription';

// ─── Alert Modal (destructive confirm) ───────────────────────────────────────

// Same back-button wiring as <Modal> above, applied to the separate Radix
// AlertDialog primitive used for destructive confirmations.
const AlertModal = ({
  open,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) => {
  useBackButtonClose(!!open, () => onOpenChange?.(false));
  return <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} />;
};
AlertModal.displayName = 'AlertModal';
const AlertModalTrigger = AlertDialogPrimitive.Trigger;

const AlertModalContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, children, style, ...props }, ref) => (
  <AlertDialogPrimitive.Portal>
    <AlertDialogPrimitive.Overlay
      style={{ zIndex: MODAL_Z_OVERLAY }}
      className="fixed inset-0 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <AlertDialogPrimitive.Content
      ref={ref}
      style={{ ...style, zIndex: MODAL_Z_CONTENT }}
      className={cn(
        'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
        'w-full max-w-md bg-white rounded-xl border border-border shadow-xl',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        // Same height cap as ModalContent — a long confirm message must scroll, not overflow the viewport
        'duration-200 outline-none overflow-y-auto overflow-x-hidden max-h-[90dvh]',
        className
      )}
      {...props}
    >
      {children}
    </AlertDialogPrimitive.Content>
  </AlertDialogPrimitive.Portal>
));
AlertModalContent.displayName = 'AlertModalContent';

const AlertModalHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-8 pb-0', className)} {...props} />
);

const AlertModalFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex gap-3 bg-surface px-6 py-4 border-t border-border', className)} {...props} />
);

const AlertModalTitle = AlertDialogPrimitive.Title;
const AlertModalDescription = AlertDialogPrimitive.Description;
const AlertModalAction = AlertDialogPrimitive.Action;
const AlertModalCancel = AlertDialogPrimitive.Cancel;

export {
  Modal, ModalTrigger, ModalClose, ModalContent,
  ModalHeader, ModalBody, ModalFooter, ModalTitle, ModalDescription,
  AlertModal, AlertModalTrigger, AlertModalContent,
  AlertModalHeader, AlertModalFooter,
  AlertModalTitle, AlertModalDescription, AlertModalAction, AlertModalCancel,
};
