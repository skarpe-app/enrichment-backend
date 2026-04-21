-- Auth trigger: auto-create profile row when a new user signs up via Supabase Auth.
-- Run against DATABASE_URL_DIRECT after the Prisma migration creates the profiles table.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, role, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    coalesce(NEW.raw_user_meta_data->>'name', NULL),
    'USER',
    now(),
    now()
  );
  RETURN NEW;
END;
$$;

-- Drop first to make idempotent
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
