import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const WORK_DIR = resolve(process.env.JARVIS_WORK_DIR || join(homedir(), '.jarvis-work'))

export function prepareOutputFolders(directory) {
  const folders = Object.fromEntries(['reports', 'artifacts', 'logs', 'tmp'].map((name) => [name, join(directory, name)]))
  for (const path of Object.values(folders)) mkdirSync(path, { recursive: true, mode: 0o700 })
  return folders
}

export function sessionWorkspace(id, root = WORK_DIR) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid conversation workspace ID.')
  const directory = join(root, 'sessions', id)
  prepareOutputFolders(directory)
  return directory
}

export function saveAgentReport(directory, report) {
  const folders = prepareOutputFolders(directory)
  const entry = { at: new Date().toISOString(), ...report }
  appendFileSync(join(folders.logs, 'reports.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  const path = join(folders.reports, 'latest.md')
  const artifacts = report.artifacts?.length ? `\n\n## Results\n\n${report.artifacts.map((item) => `- ${item}`).join('\n')}` : ''
  const needs = report.need?.length ? `\n\n## Needed\n\n${report.need.map((item) => `- ${item}`).join('\n')}` : ''
  writeFileSync(path, `# Agent Report\n\nStatus: ${report.status}\nUpdated: ${entry.at}\n\n${report.summary}${artifacts}${needs}\n`, { mode: 0o600 })
  return path
}

export function saveOutputLog(directory, name, data) {
  if (!['worker', 'commands'].includes(name)) throw new Error('Invalid output log name.')
  const folders = prepareOutputFolders(directory)
  appendFileSync(join(folders.logs, `${name}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`, { mode: 0o600 })
}

export function resolvedOutputPath(path) {
  let parent = resolve(path)
  const suffix = []
  while (true) {
    try { return resolve(realpathSync(parent), ...suffix) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const next = dirname(parent)
      if (next === parent) throw error
      suffix.unshift(basename(parent))
      parent = next
    }
  }
}

export function outputWriteError(path, directory, projectRoots = []) {
  const target = resolvedOutputPath(resolve(directory, String(path).replace(/^~(?=\/|$)/, homedir())))
  const allowed = [directory, ...projectRoots].some((root) => {
    const rel = relative(resolvedOutputPath(root), target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
  })
  return allowed ? null : `Generated files must stay in ${directory}; only project source edits may use configured project roots.`
}

export function toolOutputError(name, input, directory, projectRoots = []) {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__jarvis_files__fs_write'].includes(name)) return null
  const path = input.file_path ?? input.notebook_path ?? input.path
  return path ? outputWriteError(path, directory, projectRoots) : 'A file output path is required.'
}

export function outputGuide(directory) {
  return `OUTPUT ORGANIZATION
- Save ALL generated reports, research, exports, downloads, screenshots, command output and temporary files under ${directory}. Never scatter generated files in the home folder, /tmp, or unrelated project folders.
- Use reports/ for final Markdown reports, artifacts/ for deliverables (grouped by project or topic), logs/ for command logs, and tmp/ for disposable intermediate files. Use descriptive filenames and dated subfolders for repeated reports; reuse the same topic folder rather than creating duplicates.
- Editing actual project source/configuration at its existing location is allowed only when the user's task requires it; generated reports and scratch files still belong here. Keep JARVIS internal configuration, memory and credentials in their existing managed locations.
- Pass this output location and these rules to EVERY delegated agent, including session subagents. Direct browser/tool downloads and screenshots here explicitly. Return the saved result paths when reporting completion.`
}