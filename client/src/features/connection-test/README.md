# Supabase connection test

Route: `#/test`

Checks Vite environment variables, anonymous read access, product rows and WH001 warehouse scope. It also provides a read-only browser for previewing up to 50 rows from each table in the shared schema.

The browser uses the Vite anonymous key and therefore respects Supabase RLS. Never expose the service-role key to this page.
