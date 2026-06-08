(* =========================================================================
   example_2oo3_hpsd.st
   High-Pressure Shutdown (HPSD) — Safety Instrumented Function example.

   Demonstrates IEC 61511 SIS concepts using a 2oo3 (two-out-of-three)
   voting architecture on three redundant pressure transmitters.

   This program is for educational use in OTForge labs. It runs on the
   standard OpenPLC runtime — no SIL certification is implied.

   -------------------------------------------------------------------------
   Process description:
     Three pressure transmitters (PT-101A/B/C) monitor a reactor feed line.
     If two or more transmitters read HIGH (coil = TRUE), the SIS trips:
       - SDV-101 (shutdown valve) is de-energized to CLOSED
       - ESD-K1  (emergency shutdown relay) is de-energized

   De-energize-to-trip (fail-safe): outputs are energized during normal
   operation and de-energized on trip, so a power or wiring fault causes
   a safe trip rather than a missed trip (IEC 61511-1 Cl. 11.4.3).

   -------------------------------------------------------------------------
   Variable map (Modbus coil / holding register addresses):
     %IX0.0  PT-101A pressure HIGH signal (from sensor coil)
     %IX0.1  PT-101B pressure HIGH signal
     %IX0.2  PT-101C pressure HIGH signal
     %IX0.3  BYPASS  maintenance bypass (inhibits trip — alarmed separately)
     %QX0.0  SDV-101 — shutdown valve (TRUE = open/energized, FALSE = tripped)
     %QX0.1  ESD-K1  — ESD relay (TRUE = normal, FALSE = tripped)
     %QX0.2  TRIP_ALARM — TRUE when SIS is in tripped state
     %QX0.3  BYPASS_ALARM — TRUE when maintenance bypass is active
     %MW0    VOTED_COUNT — number of sensors reading HIGH (0-3), for HMI display
   =========================================================================
*)

PROGRAM HPSD_2oo3

  (* ── Inputs ────────────────────────────────────────────────────── *)
  VAR_INPUT
    PT_101A   AT %IX0.0 : BOOL;  (* Pressure transmitter A — HIGH trip signal *)
    PT_101B   AT %IX0.1 : BOOL;  (* Pressure transmitter B — HIGH trip signal *)
    PT_101C   AT %IX0.2 : BOOL;  (* Pressure transmitter C — HIGH trip signal *)
    BYPASS    AT %IX0.3 : BOOL;  (* Maintenance bypass — inhibits SIS trip    *)
  END_VAR

  (* ── Outputs ───────────────────────────────────────────────────── *)
  VAR_OUTPUT
    SDV_101      AT %QX0.0 : BOOL;  (* Shutdown valve   — de-energize to close  *)
    ESD_K1       AT %QX0.1 : BOOL;  (* ESD relay        — de-energize to trip   *)
    TRIP_ALARM   AT %QX0.2 : BOOL;  (* Trip status lamp — TRUE = tripped        *)
    BYPASS_ALARM AT %QX0.3 : BOOL;  (* Bypass active warning lamp               *)
  END_VAR

  (* ── Internal variables ────────────────────────────────────────── *)
  VAR
    VOTED_COUNT AT %MW0 : INT;   (* Sensors reading HIGH — written to HMI  *)
    VOTE_TRIP         : BOOL;    (* TRUE when 2 or more sensors are HIGH   *)
    LATCHED_TRIP      : BOOL;    (* Trip latch — holds until manual reset  *)
    (* Note: add a RESET input (%IX0.4) for full IEC 61511 compliance *)
  END_VAR

  (* ── 2oo3 voting logic ─────────────────────────────────────────── *)
  (* Count how many of the three sensors are reading HIGH.            *)
  VOTED_COUNT := BOOL_TO_INT(PT_101A) +
                 BOOL_TO_INT(PT_101B) +
                 BOOL_TO_INT(PT_101C);

  (* Trip if two or more sensors vote HIGH (2oo3 architecture).       *)
  VOTE_TRIP := (VOTED_COUNT >= 2);

  (* ── Trip latch ────────────────────────────────────────────────── *)
  (* Once tripped, hold the trip state until an operator reset.       *)
  (* In this example the latch is self-clearing when all sensors      *)
  (* return to normal — add a RESET coil for full manual-reset SIS.  *)
  IF VOTE_TRIP THEN
    LATCHED_TRIP := TRUE;
  END_IF;

  IF NOT VOTE_TRIP THEN
    (* Auto-reset for lab simplicity — real SIS requires manual reset *)
    LATCHED_TRIP := FALSE;
  END_IF;

  (* ── Bypass handling ───────────────────────────────────────────── *)
  (* Bypass inhibits the trip output. Must be alarmed per IEC 61511.  *)
  BYPASS_ALARM := BYPASS;

  (* ── Output drive (de-energize-to-trip) ───────────────────────── *)
  (* Outputs are TRUE (energized) during normal operation.            *)
  (* They de-energize (FALSE) when a trip occurs AND bypass is off.   *)
  IF LATCHED_TRIP AND NOT BYPASS THEN
    SDV_101    := FALSE;   (* Close isolation valve *)
    ESD_K1     := FALSE;   (* Drop ESD relay        *)
    TRIP_ALARM := TRUE;
  ELSE
    SDV_101    := TRUE;    (* Valve open — normal operation *)
    ESD_K1     := TRUE;    (* Relay energized — normal      *)
    TRIP_ALARM := FALSE;
  END_IF;

END_PROGRAM

(*
  =========================================================================
  Configuration notes for OTForge scenario authors:

  1. Load this program into OpenPLC via the web IDE (localhost:18080).
  2. Connect three field sensor devices to %IX0.0, %IX0.1, %IX0.2 using
     a Modbus slave device in the OpenPLC hardware configuration.
  3. Wire %QX0.0 (SDV-101) to an actuator or valve device downstream.
  4. In the scenario, set safetyPlc.votingConfig = "2oo3" and
     safetyPlc.safeState = "Close SDV-101, de-energize ESD-K1".
  5. To simulate an attack: write TRUE to two or more pressure sensor
     coils from the attack machine using a Modbus coil-write command.
     The SIS should trip within one PLC scan cycle (~10 ms).
  6. To demonstrate bypass vulnerability: set %IX0.3 = TRUE from the
     attack machine before writing the pressure coils. The SIS will not
     trip even with two sensors reading HIGH — demonstrating why bypass
     management is a critical ICS security control (IEC 62443-3-3 SR 3.6).
  =========================================================================
*)
