"use client";

import { useActionState, useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import {
  createCategory,
  createItem,
  deleteCategory,
  deleteItem,
  updateItem,
} from "@/lib/pos/actions";
import { paiseToRupees } from "@/lib/money";
import { STATIONS, type MenuCategory, type MenuItem } from "@/lib/pos/types";

const inputCls =
  "rounded-xl border hairline bg-pine px-3 py-2 text-sm text-paper outline-none focus:border-amber";

function ConfirmButton({
  children,
  message,
  className,
}: {
  children: React.ReactNode;
  message: string;
  className?: string;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}

function MenuItemRow({ item }: { item: MenuItem }) {
  const [state, action, pending] = useActionState(updateItem, null);

  return (
    <div className="rounded-xl border hairline bg-forest/60 p-3">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={item.id} />

        <input
          name="name"
          defaultValue={item.name}
          required
          className={`${inputCls} min-w-40 flex-1`}
          aria-label="Item name"
        />

        <label className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-sage">₹</span>
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            defaultValue={paiseToRupees(item.price_paise)}
            required
            className={`${inputCls} w-28 pl-6`}
            aria-label="Price in rupees"
          />
        </label>

        <select
          name="station"
          defaultValue={item.kitchen_station}
          className={`${inputCls} w-28`}
          aria-label="Kitchen station"
        >
          {STATIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 px-1 text-xs text-sage">
          <input
            type="checkbox"
            name="is_available"
            defaultChecked={item.is_available}
            className="h-4 w-4 accent-amber"
          />
          Available
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </form>

      <div className="mt-1 flex min-h-5 items-center justify-between gap-2 px-1">
        <span className="text-xs">
          {state?.ok ? <span className="text-sage">Saved ✓</span> : null}
          {state && !state.ok ? <span className="text-ember">{state.error}</span> : null}
        </span>
        <form action={deleteItem}>
          <input type="hidden" name="id" value={item.id} />
          <ConfirmButton
            message={`Delete "${item.name}"?`}
            className="inline-flex items-center gap-1 text-xs text-sage transition-colors hover:text-ember"
          >
            <Trash2 size={13} /> Delete
          </ConfirmButton>
        </form>
      </div>
    </div>
  );
}

function AddItemForm({ categoryId }: { categoryId: string }) {
  const [state, action, pending] = useActionState(createItem, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-dashed hairline p-3"
    >
      <input type="hidden" name="category_id" value={categoryId} />
      <input
        name="name"
        placeholder="New item name"
        required
        className={`${inputCls} min-w-40 flex-1`}
      />
      <label className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-sage">₹</span>
        <input
          name="price"
          type="number"
          min="0"
          step="0.01"
          placeholder="0"
          required
          className={`${inputCls} w-28 pl-6`}
        />
      </label>
      <select name="station" defaultValue="main" className={`${inputCls} w-28`}>
        {STATIONS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded-full border border-amber/60 px-4 py-2 text-sm font-medium text-amber transition-colors hover:bg-amber hover:text-pine disabled:opacity-60"
      >
        {pending ? "Adding…" : "+ Add"}
      </button>
      {state && !state.ok ? (
        <span className="w-full text-xs text-ember">{state.error}</span>
      ) : null}
    </form>
  );
}

function AddCategoryForm({ nextSort }: { nextSort: number }) {
  const [state, action, pending] = useActionState(createCategory, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="flex flex-wrap items-center gap-2 rounded-card border border-dashed hairline bg-forest/40 p-4"
    >
      <input type="hidden" name="sort_order" value={nextSort} />
      <input
        name="name"
        placeholder="New category (e.g. Desserts)"
        required
        className={`${inputCls} min-w-48 flex-1`}
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-amber px-5 py-2 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-60"
      >
        {pending ? "Adding…" : "+ Add category"}
      </button>
      {state && !state.ok ? (
        <span className="w-full text-xs text-ember">{state.error}</span>
      ) : null}
    </form>
  );
}

export function MenuManager({ categories }: { categories: MenuCategory[] }) {
  const nextSort =
    categories.reduce((max, c) => Math.max(max, c.sort_order), 0) + 1;

  return (
    <div className="space-y-8">
      {categories.map((cat) => (
        <section key={cat.id}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-display text-xl font-bold text-paper">{cat.name}</h2>
            <form action={deleteCategory}>
              <input type="hidden" name="id" value={cat.id} />
              <ConfirmButton
                message={`Delete "${cat.name}" and all its items?`}
                className="inline-flex items-center gap-1 text-xs text-sage transition-colors hover:text-ember"
              >
                <Trash2 size={13} /> Delete category
              </ConfirmButton>
            </form>
          </div>

          <div className="space-y-2">
            {cat.items.length === 0 ? (
              <p className="text-sm text-sage/70">No items yet.</p>
            ) : (
              cat.items.map((item) => <MenuItemRow key={item.id} item={item} />)
            )}
          </div>

          <AddItemForm categoryId={cat.id} />
        </section>
      ))}

      <AddCategoryForm nextSort={nextSort} />
    </div>
  );
}
