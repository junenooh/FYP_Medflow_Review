-- Planner dashboard uses the anon key. Paste this in the SQL editor:
-- https://supabase.com/dashboard/project/ikjrcfqleskfgatsxdjr/sql/new
-- service_role already bypasses RLS (engines). This only grants SELECT to anon.

do $$
declare
  t text;
begin
  foreach t in array array[
    'warehouse',
    'site',
    'zone',
    'bin',
    'product',
    'storage',
    'inventory',
    'orders',
    'orderline',
    'stocktransfer',
    'stocktransferline',
    'consumption',
    'demand',
    'warehouseproduct',
    'warehouseproductcalculation',
    'modelrun',
    'productrelationship',
    'productrelationshipantecedent',
    'replenishmentrecommendation',
    'layoutrecommendation'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists anon_read_%I on public.%I', t, t);
    execute format(
      'create policy anon_read_%I on public.%I for select to anon, authenticated using (true)',
      t, t
    );
  end loop;
end $$;
