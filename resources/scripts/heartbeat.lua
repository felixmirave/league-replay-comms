-- Owned playback must stop if the controlling utility process disappears.
local last_heartbeat = mp.get_time()
local connected = false
mp.register_script_message('comms-heartbeat', function()
    last_heartbeat = mp.get_time()
    connected = true
end)
mp.add_periodic_timer(0.25, function()
    local deadline = connected and 1.5 or 5
    if mp.get_time() - last_heartbeat > deadline then
        mp.commandv('quit')
    end
end)
