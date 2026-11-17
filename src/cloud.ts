import { createClient } from '@supabase/supabase-js'
import { pack, unpack } from './workspace'
import type { Workspace } from './model'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const cloud = url && key ? createClient(url, key) : null
export type CloudSet = { id: string; title: string; bytes: number; updated_at: string; share_id: string | null }

function configured() {
  if (!cloud) throw new Error('Cloud accounts are not configured for this deployment.')
  return cloud
}

async function rpc<T>(name: string, parameters: Record<string, unknown> = {}) {
  const { data, error } = await configured().rpc(name, parameters)
  if (error) throw new Error(error.message)
  return data as T
}

async function encode(workspace: Workspace, max: number) {
  if (!workspace.project.recordings.length) throw new Error('Add a recording first.')
  const bytes = await pack(workspace)
  if (bytes.length > max) throw new Error(`This set exceeds the ${max / 1024 / 1024} MB cloud limit. You can still export it locally.`)
  return btoa(Array.from({ length: Math.ceil(bytes.length / 8192) }, (_, index) =>
    String.fromCharCode(...bytes.subarray(index * 8192, (index + 1) * 8192))).join(''))
}

function decode(base64: string | null, description: string) {
  if (!base64) throw new Error(description)
  return unpack(Uint8Array.from(atob(base64), b => b.charCodeAt(0)))
}

export async function signIn() {
  const redirect = new URL(window.location.href)
  redirect.search = ''
  redirect.hash = ''
  const { error } = await configured().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirect.href } })
  if (error) throw new Error(error.message)
}

export async function signOut() {
  const { error } = await configured().auth.signOut()
  if (error) throw new Error(error.message)
}

export const listCloud = () => rpc<CloudSet[]>('tc_list_sets')
export async function saveCloud(workspace: Workspace, id: string | null) {
  return rpc<string>('tc_save_set', { p_id: id, p_title: workspace.project.title, p_data: await encode(workspace, 5 * 1024 * 1024) })
}
export async function openCloud(id: string) {
  return decode(await rpc<string | null>('tc_get_set', { p_id: id }), 'This saved set is unavailable.')
}
export async function publishCloud(workspace: Workspace, id: string) {
  return rpc<string>('tc_publish_set', { p_id: id, p_data: await encode(workspace, 1024 * 1024) })
}
export async function openPublic(id: string) {
  return decode(await rpc<string | null>('tc_get_share', { p_id: id }), 'This public link is unavailable or has been revoked.')
}
export const revokeCloud = (id: string) => rpc<void>('tc_revoke_share', { p_id: id })
export const deleteCloud = (id: string) => rpc<void>('tc_delete_set', { p_id: id })
