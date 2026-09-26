vim.opt.mouse = 'a'
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.statuscolumn = '%{v:lnum} %{v:relnum + 1} %s'
vim.opt.hidden = true

vim.pack.add({ 'https://github.com/nvim-tree/nvim-tree.lua' })

require('nvim-tree').setup({
  sync_root_with_cwd = false,
  update_focused_file = { enable = false, update_root = { enable = false } },
  actions = {
    change_dir = { enable = false },
    open_file = { quit_on_open = true },
  },
  on_attach = function(bufnr)
    local api = require('nvim-tree.api')
    api.map.on_attach.default(bufnr)
    vim.keymap.del('n', '<2-LeftMouse>', { buffer = bufnr })
    vim.keymap.set('n', '<LeftRelease>', api.node.open.edit, {
      buffer = bufnr,
      silent = true,
      nowait = true,
      desc = 'Open file or toggle folder',
    })

    local function go_right()
      local node = api.tree.get_node_under_cursor()
      if not node or not node.parent or not node.nodes then
        return
      end
      local dir = node:last_group_node()
      if not dir.open then
        api.node.open.edit()
      end

      local win = vim.api.nvim_get_current_win()
      local cursor = vim.api.nvim_win_get_cursor(win)
      if cursor[1] >= vim.api.nvim_buf_line_count(bufnr) then
        return
      end
      vim.api.nvim_win_set_cursor(win, { cursor[1] + 1, 0 })
      local child = api.tree.get_node_under_cursor()
      local parent = child and child.parent
      while parent and parent ~= dir do
        parent = parent.parent
      end
      if not parent then
        vim.api.nvim_win_set_cursor(win, cursor)
      end
    end

    local function go_left()
      local node = api.tree.get_node_under_cursor()
      if not node or not node.parent then
        return
      end
      if node.nodes and node:last_group_node().open then
        api.node.open.edit()
      else
        api.node.navigate.parent_close()
      end
    end

    vim.keymap.set('n', '<Right>', go_right, {
      buffer = bufnr, silent = true, nowait = true, desc = 'Expand folder or enter first child',
    })
    vim.keymap.set('n', '<Left>', go_left, {
      buffer = bufnr, silent = true, nowait = true, desc = 'Collapse folder or select parent',
    })
  end,
})

vim.keymap.set('n', '<leader>e', '<cmd>NvimTreeToggle<cr>', { silent = true, desc = 'Toggle file tree' })

local terminal_buf
local terminal_wins = {}
local workspace_host
local local_root
local active_mount
local mounts = {}
local switching = false
local picking = false
local session_dir
local pending_mount
local pending_job

local function message(text, level)
  vim.notify('SSH workspace: ' .. text, level or vim.log.levels.ERROR)
end

local function aliases()
  local result, seen, files = {}, {}, {}
  local ssh_dir = vim.fn.expand('~/.ssh')
  local config = ssh_dir .. '/config'
  if not vim.uv.fs_stat(config) then
    return nil, 'No ~/.ssh/config found.'
  end

  local function tokens(line)
    local words = {}
    local i = 1
    while i <= #line do
      while line:sub(i, i):match('%s') do i = i + 1 end
      local quote, word = nil, {}
      while i <= #line do
        local c = line:sub(i, i)
        if not quote and (c == '#' or c:match('%s')) then break end
        if (c == '"' or c == "'") and (not quote or quote == c) then
          quote = quote and nil or c
        elseif c == '\\' and i < #line then
          i = i + 1
          word[#word + 1] = line:sub(i, i)
        else
          word[#word + 1] = c
        end
        i = i + 1
      end
      if #word > 0 then words[#words + 1] = table.concat(word) end
      if line:sub(i, i) == '#' then break end
      i = i + 1
    end
    return words
  end

  local function scan(path, depth)
    if depth > 12 or files[path] then return end
    files[path] = true
    local file = io.open(path, 'r')
    if not file then return end
    for line in file:lines() do
      local words = tokens(line)
      local directive = words[1] and words[1]:lower()
      if directive == 'host' then
        for i = 2, #words do
          local alias = words[i]
          if alias:match('^[%w][%w_.%-]*$') and not seen[alias] then
            seen[alias] = true
            result[#result + 1] = alias
          end
        end
      elseif directive == 'include' then
        for i = 2, #words do
          local pattern = words[i]
          if pattern:sub(1, 2) == '~/' then
            pattern = vim.fn.expand('~') .. pattern:sub(2)
          elseif pattern:sub(1, 1) ~= '/' then
            pattern = ssh_dir .. '/' .. pattern
          end
          if not pattern:find('`', 1, true) then
            for _, match in ipairs(vim.fn.glob(pattern, false, true)) do
              local stat = vim.uv.fs_stat(match)
              if stat and stat.type == 'file' then scan(match, depth + 1) end
            end
          end
        end
      end
    end
    file:close()
  end

  scan(config, 0)
  return result
end

local function mounted(path)
  local file = io.open('/proc/self/mountinfo', 'r')
  if not file then return false end
  for line in file:lines() do
    local point = line:match('^%S+ %S+ %S+ %S+ (%S+) ')
    if point and point:gsub('\\(%d%d%d)', function(oct)
      return string.char(tonumber(oct, 8))
    end) == path then
      file:close()
      return true
    end
  end
  file:close()
  return false
end

local function remove_mount_dir(path)
  if mounted(path) then return end
  vim.uv.fs_rmdir(path)
end

local function mount_home(host, done)
  local base = vim.fn.stdpath('state') .. '/ssh-workspaces'
  if not session_dir then
    if not vim.uv.fs_lstat(base) then
      local ok, err = vim.uv.fs_mkdir(base, 448)
      if not ok then done(nil, err); return end
    end
    local stat = vim.uv.fs_lstat(base)
    if not stat or stat.type ~= 'directory' or stat.uid ~= vim.uv.getuid()
        or stat.mode % 64 ~= 0 then
      done(nil, 'Workspace directory must be owned by you and private: ' .. base)
      return
    end
    local path = base .. '/nvim-' .. vim.fn.getpid() .. '-' .. tostring(vim.uv.hrtime())
    local ok, err = vim.uv.fs_mkdir(path, 448)
    if not ok then done(nil, err); return end
    session_dir = path
  end
  local path = session_dir .. '/' .. tostring(#mounts + 1)
  local ok, err = vim.uv.fs_mkdir(path, 448)
  if not ok then done(nil, err); return end
  pending_mount = path
  local started, start_err = pcall(vim.system,
    { 'sshfs', '-o', 'BatchMode=yes,ConnectTimeout=10,ConnectionAttempts=1', host .. ':', path },
    { text = true, timeout = 25000 }, function(result)
      vim.schedule(function()
        pending_mount = nil
        pending_job = nil
        if result.code == 0 and mounted(path) then
          mounts[#mounts + 1] = path
          done(path)
        else
          local detail = 'sshfs failed (exit ' .. tostring(result.code)
            .. '). Check host settings, network and SSH agent; password prompts are disabled.'
          if mounted(path) then
            mounts[#mounts + 1] = path
          else
            remove_mount_dir(path)
          end
          done(nil, detail)
        end
      end)
    end)
  if started then
    pending_job = start_err
  else
    pending_mount = nil
    remove_mount_dir(path)
    done(nil, 'Could not launch sshfs: ' .. tostring(start_err))
  end
end

local function reset_terminal()
  local previous = vim.api.nvim_get_current_win()
  if terminal_buf and vim.api.nvim_buf_is_valid(terminal_buf) then
    for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
      for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
        if vim.api.nvim_win_get_buf(win) == terminal_buf then
          if #vim.api.nvim_tabpage_list_wins(tab) == 1 then
            vim.api.nvim_win_set_buf(win, vim.api.nvim_create_buf(true, false))
          else
            vim.api.nvim_win_close(win, true)
          end
        end
      end
    end
    local job = vim.b[terminal_buf].terminal_job_id
    if job then vim.fn.jobstop(job) end
    vim.api.nvim_buf_delete(terminal_buf, { force = true })
  end
  terminal_buf = nil
  terminal_wins = {}
  if vim.api.nvim_win_is_valid(previous) then vim.api.nvim_set_current_win(previous) end
end

local function change_workspace(host, path)
  local api = require('nvim-tree.api')
  local core = require('nvim-tree.core')
  local previous_root = core.get_cwd() or vim.fn.getcwd()
  local previous_win = vim.api.nvim_get_current_win()
  local ok, err = pcall(function()
    if not api.tree.is_visible() then api.tree.open({ path = path }) end
    api.tree.change_root(path)
    if core.get_cwd() ~= path then error('tree did not change root') end
  end)
  if vim.api.nvim_win_is_valid(previous_win) then vim.api.nvim_set_current_win(previous_win) end
  if not ok then
    if core.get_cwd() ~= previous_root then pcall(api.tree.change_root, previous_root) end
    return false, err
  end
  if not workspace_host then local_root = previous_root end
  reset_terminal()
  workspace_host = host
  active_mount = path
  return true
end

local function choose_host()
  if switching or picking then message('A workspace selection is already in progress.'); return end
  if vim.fn.executable('sshfs') == 0 then
    message('sshfs is missing. Install it with your distribution package manager.')
    return
  end
  if vim.fn.executable('ssh') == 0 then message('ssh is missing.'); return end
  local hosts, err = aliases()
  if not hosts then message(err); return end
  if #hosts == 0 then message('No literal Host aliases found in ~/.ssh/config.'); return end
  picking = true
  vim.ui.select(hosts, { prompt = 'SSH workspace:' }, function(host)
    picking = false
    if not host then return end
    if switching then message('A mount is already in progress.'); return end
    if host == workspace_host then
      local api = require('nvim-tree.api')
      if not api.tree.is_visible() then api.tree.open({ path = active_mount }) end
      api.tree.change_root(active_mount)
      return
    end
    switching = true
    mount_home(host, function(path, why)
      switching = false
      if not path then message('Mount failed: ' .. tostring(why)); return end
      local ok, change_err = change_workspace(host, path)
      if not ok then message('Mounted, but could not change tree root: ' .. tostring(change_err)) end
    end)
  end)
end

local function return_local()
  if switching or picking then message('Finish the workspace selection first.'); return end
  if not workspace_host then message('Already in the local workspace.', vim.log.levels.INFO); return end
  local ok, err = change_workspace(nil, local_root)
  if not ok then message('Could not restore local tree: ' .. tostring(err)) end
end

vim.api.nvim_create_user_command('SSHWorkspace', choose_host, {})
vim.api.nvim_create_user_command('LocalWorkspace', return_local, {})
vim.keymap.set('n', '<leader>sh', choose_host, { desc = 'Choose SSH workspace' })
vim.keymap.set('n', '<leader>sl', return_local, { desc = 'Return to local workspace' })

vim.api.nvim_create_autocmd('VimLeave', {
  callback = function()
    if pending_job then pending_job:kill(15) end
    if pending_mount then mounts[#mounts + 1] = pending_mount end
    for _, path in ipairs(mounts) do
      if mounted(path) then
        vim.system({ 'fusermount3', '-uz', path }, { timeout = 1500 }):wait(1800)
      end
      remove_mount_dir(path)
    end
    if session_dir then vim.uv.fs_rmdir(session_dir) end
  end,
})

local function toggle_terminal()
  local tab = vim.api.nvim_get_current_tabpage()
  local panel = terminal_wins[tab]
  if panel and vim.api.nvim_win_is_valid(panel.win)
      and vim.api.nvim_win_get_buf(panel.win) == panel.buf then
    if #vim.api.nvim_tabpage_list_wins(tab) == 1 then
      vim.cmd('enew')
    else
      vim.api.nvim_win_close(panel.win, true)
    end
    terminal_wins[tab] = nil
    return
  end

  terminal_wins[tab] = nil
  if terminal_buf and vim.api.nvim_buf_is_valid(terminal_buf) then
    local job = vim.b[terminal_buf].terminal_job_id
    if not job or vim.fn.jobwait({ job }, 0)[1] ~= -1 then
      terminal_buf = nil
    end
  else
    terminal_buf = nil
  end

  vim.cmd('botright 12split')
  local terminal_win = vim.api.nvim_get_current_win()
  if terminal_buf then
    vim.api.nvim_win_set_buf(terminal_win, terminal_buf)
  else
    if workspace_host then
      vim.cmd('enew')
      vim.fn.termopen({ 'ssh', '-t', workspace_host })
      terminal_buf = vim.api.nvim_get_current_buf()
    else
      vim.cmd('terminal')
      terminal_buf = vim.api.nvim_get_current_buf()
    end
  end
  terminal_wins[tab] = { win = terminal_win, buf = terminal_buf }
  vim.cmd('startinsert')
end

vim.keymap.set({ 'n', 't' }, '<leader>t', toggle_terminal, { silent = true })
