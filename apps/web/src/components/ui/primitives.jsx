import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ---------- Button ---------- */
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*="size-"])]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground border border-border hover:bg-accent',
        outline: 'border border-border bg-transparent hover:bg-accent',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive/90 text-white hover:bg-destructive',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: { default: 'h-9 px-4 py-2', sm: 'h-8 px-3 text-xs', lg: 'h-10 px-6', icon: 'size-9' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export const Button = React.forwardRef(function Button({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {asChild ? children : (<>{loading && <Loader2 className="animate-spin" />}{children}</>)}
    </Comp>
  );
});

/* ---------- Inputs ---------- */
const fieldBase =
  'w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive';

export const Input = React.forwardRef(function Input({ className, type = 'text', ...props }, ref) {
  return <input ref={ref} type={type} className={cn(fieldBase, 'h-9 py-1', className)} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, 'min-h-24 py-2 leading-relaxed', className)} {...props} />;
});

export const Select = React.forwardRef(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(fieldBase, 'h-9 appearance-none bg-no-repeat py-1 pr-8', className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23a1a1aa' stroke-width='2' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", backgroundPosition: 'right 0.5rem center' }} {...props}>
      {children}
    </select>
  );
});

export function Label({ className, ...props }) {
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />;
}

export function Field({ label, htmlFor, hint, error, children, className }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/* ---------- Card ---------- */
export function Card({ className, ...props }) {
  return <div className={cn('rounded-xl border border-border bg-card text-card-foreground', className)} {...props} />;
}
export function CardHeader({ className, ...props }) {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}
export function CardTitle({ className, ...props }) {
  return <h3 className={cn('text-sm font-semibold leading-none tracking-tight', className)} {...props} />;
}
export function CardDescription({ className, ...props }) {
  return <p className={cn('text-xs text-muted-foreground', className)} {...props} />;
}
export function CardContent({ className, ...props }) {
  return <div className={cn('p-5 pt-2', className)} {...props} />;
}

/* ---------- Badge ---------- */
const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'border-border bg-secondary text-muted-foreground',
      primary: 'border-primary/30 bg-primary/15 text-violet-300',
      success: 'border-success/30 bg-success/10 text-success',
      warning: 'border-warning/30 bg-warning/10 text-warning',
      danger: 'border-destructive/30 bg-destructive/10 text-red-400',
      info: 'border-info/30 bg-info/10 text-info',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
export function Badge({ className, tone, ...props }) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* ---------- Misc ---------- */
export function Skeleton({ className, ...props }) {
  return <div className={cn('animate-pulse-soft rounded-md bg-accent', className)} aria-hidden="true" {...props} />;
}

export function Spinner({ className }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted-foreground', className)} aria-label="Loading" />;
}

export function Separator({ className }) {
  return <div role="separator" className={cn('h-px w-full bg-border', className)} />;
}

export const Switch = React.forwardRef(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root ref={ref} className={cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors data-[state=checked]:bg-primary', className)} {...props}>
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4.5" />
    </SwitchPrimitive.Root>
  );
});

export const Checkbox = React.forwardRef(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root ref={ref} className={cn('flex size-4 shrink-0 items-center justify-center rounded border border-input data-[state=checked]:border-primary data-[state=checked]:bg-primary', className)} {...props}>
      <CheckboxPrimitive.Indicator><Check className="size-3 text-white" /></CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }) {
  return <TabsPrimitive.List className={cn('inline-flex items-center gap-1 rounded-lg bg-secondary p-1', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }) {
  return (
    <TabsPrimitive.Trigger
      className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors data-[state=active]:bg-background data-[state=active]:text-foreground', className)}
      {...props}
    />
  );
}
export const TabsContent = TabsPrimitive.Content;

export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center', className)}>
      {Icon && <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground"><Icon className="size-5" /></span>}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mx-auto max-w-sm text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorNotice({ error, onRetry, className }) {
  if (!error) return null;
  return (
    <div role="alert" className={cn('flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm', className)}>
      <div>
        <p className="font-medium text-red-300">Something went wrong</p>
        <p className="text-xs text-red-200/80">{error.message}</p>
      </div>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
