##! ICS Simulator — Zeek monitoring script
##! Enables Modbus and DNP3 protocol analysis and logs ICS-specific events.

@load base/frameworks/notice
@load base/protocols/modbus
@load base/protocols/dnp3

module ICSMonitor;

export {
    redef enum Notice::Type += {
        ## A Modbus write-multiple-registers command was observed.
        Modbus_Write_Registers,
        ## A DNP3 direct-operate command was observed.
        DNP3_Direct_Operate,
        ## Unusual cross-zone ICS traffic.
        Cross_Zone_Traffic,
    };
}

# ── Network definitions ───────────────────────────────────────────────────────
# Subnets are dynamically assigned at simulation start by findFreeSubnets() and
# may be anything in 10.x.x.x space — do NOT hardcode specific /24s here.
# All 10.0.0.0/8 addresses are simulation-internal; anything outside is external
# (e.g., public internet reached from the attacker VM).

const SIMULATION_NET: subnet = 10.0.0.0/8;

function zone_name(a: addr): string {
    if (a in SIMULATION_NET) return "Simulation";
    return "External";
}

# ── Modbus logging ────────────────────────────────────────────────────────────

event modbus_message(c: connection, is_orig: bool, headers: ModbusHeaders, data: ModbusData) {
    local src_zone  = zone_name(c$id$orig_h);
    local dst_zone  = zone_name(c$id$resp_h);

    if (src_zone != dst_zone) {
        NOTICE([$note=Cross_Zone_Traffic,
                $msg=fmt("Modbus %s→%s: %s:%d → %s:%d",
                         src_zone, dst_zone,
                         c$id$orig_h, c$id$orig_p,
                         c$id$resp_h, c$id$resp_p),
                $conn=c]);
    }
}

event modbus_write_multiple_registers_request(c: connection, headers: ModbusHeaders,
        start_address: count, registers: ModbusRegisters) {
    NOTICE([$note=Modbus_Write_Registers,
            $msg=fmt("Modbus WriteMultipleRegs: %s → %s  start=%d  count=%d",
                     c$id$orig_h, c$id$resp_h, start_address, |registers|),
            $conn=c]);
}

# ── DNP3 logging ──────────────────────────────────────────────────────────────

event dnp3_application_request_header(c: connection, is_orig: bool,
        fc: count, fir: bool, fin: bool, con: bool, uns: bool, seq: count) {
    # FC 3 = DIRECT_OPERATE
    if (fc == 3) {
        NOTICE([$note=DNP3_Direct_Operate,
                $msg=fmt("DNP3 DirectOperate: %s → %s",
                         c$id$orig_h, c$id$resp_h),
                $conn=c]);
    }
}

# ── Connection summary ────────────────────────────────────────────────────────

event connection_state_remove(c: connection) {
    # Log all ICS protocol connections
    if (c$id$resp_p == 502/tcp || c$id$resp_p == 20000/tcp || c$id$resp_p == 4840/tcp) {
        local proto = c$id$resp_p == 502/tcp   ? "Modbus" :
                      c$id$resp_p == 20000/tcp ? "DNP3"   : "OPC-UA";
        print fmt("[ICS] %s  %s:%d → %s:%d  duration=%.1fs  bytes=%d",
                  proto,
                  c$id$orig_h, c$id$orig_p,
                  c$id$resp_h, c$id$resp_p,
                  c$duration,
                  c$orig$size + c$resp$size);
    }
}
