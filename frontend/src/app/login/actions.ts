'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { env } from '@/lib/env';

export async function signIn(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '/dashboard');

  if (!email || !password) {
    redirect(`/login?error=${encodeURIComponent('Informe email e senha')}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const msg =
      error.message === 'Invalid login credentials'
        ? 'Email ou senha incorretos'
        : error.message === 'fetch failed' || error.message.includes('fetch')
        ? 'Não foi possível conectar ao servidor. Tente novamente em instantes.'
        : error.message;
    redirect(`/login?error=${encodeURIComponent(msg)}`);
  }
  redirect(next);
}

export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) {
    redirect(`/login?error=${encodeURIComponent('Informe seu email')}`);
  }

  const supabase = await createClient();
  const headersList = await headers();
  const origin =
    env.NEXT_PUBLIC_SITE_URL !== 'http://localhost:3000'
      ? env.NEXT_PUBLIC_SITE_URL
      : `https://${headersList.get('host')}`;

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=${encodeURIComponent('/auth/reset-password')}`,
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  // Mesma resposta com ou sem email cadastrado (não vaza existência de conta).
  redirect('/login?reset_sent=1');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
