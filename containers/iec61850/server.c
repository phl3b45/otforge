/*
 * server.c — OTForge IEC 61850 substation IED (MMS server).
 *
 * Builds a realistic-but-minimal substation feeder-bay data model at runtime
 * with libiec61850's dynamic model API, and serves it over MMS on TCP 102:
 *
 *   LD "BAY"
 *     LLN0   — Mod / Beh / Health           (mandatory)
 *     LPHD1  — PhyHealth                     (mandatory)
 *     MMXU1  — measurements (live-updating):
 *              TotW  (total active power, W)
 *              TotVAr(total reactive power, VAr)
 *              Hz    (frequency)
 *              PhV   (3-phase voltage, WYE: phsA/B/C)
 *              A     (3-phase current,  WYE: phsA/B/C)
 *     XCBR1  — Pos (controllable breaker position; clients can trip/close it)
 *
 * Deliberately uses only integer arithmetic for the measurement drift so the
 * binary needs no libm (-lm) at link time. Measurement child DataAttributes are
 * NULL-checked before update so an unexpected model path degrades gracefully
 * rather than crashing the server.
 */

#include "iec61850_server.h"
#include "hal_thread.h"
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>

static int running = 0;
static IedServer iedServer = NULL;
static DataAttribute* xcbrPosStVal = NULL;

static void sigint_handler(int signalId)
{
    (void)signalId;
    running = 0;
}

/* Apply a breaker open/close operate to XCBR1.Pos.stVal. DPC ctlVal is a
 * boolean: true = close (ON), false = open/trip (OFF). */
static ControlHandlerResult
posControlHandler(ControlAction action, void* parameter, MmsValue* ctlVal, bool test)
{
    (void)action;
    (void)parameter;
    if (test)
        return CONTROL_RESULT_OK;

    bool close = MmsValue_getBoolean(ctlVal);
    if (xcbrPosStVal != NULL)
        IedServer_updateDbposValue(iedServer, xcbrPosStVal, close ? DBPOS_ON : DBPOS_OFF);

    printf("[ics-iec61850] XCBR1.Pos operated -> %s\n", close ? "CLOSED" : "OPEN (tripped)");
    fflush(stdout);
    return CONTROL_RESULT_OK;
}

static void
updateIfPresent(DataAttribute* attr, float value)
{
    if (attr != NULL)
        IedServer_updateFloatAttributeValue(iedServer, attr, value);
}

int main(int argc, char** argv)
{
    int tcpPort = 102;
    if (argc > 1)
        tcpPort = atoi(argv[1]);

    /* ── Data model ──────────────────────────────────────────────────────── */
    IedModel* model = IedModel_create("OTForgeIED");
    LogicalDevice* bay = LogicalDevice_create("BAY", model);

    LogicalNode* lln0 = LogicalNode_create("LLN0", bay);
    CDC_ENS_create("Mod", (ModelNode*) lln0, 0);
    CDC_ENS_create("Beh", (ModelNode*) lln0, 0);
    CDC_ENS_create("Health", (ModelNode*) lln0, 0);

    LogicalNode* lphd1 = LogicalNode_create("LPHD1", bay);
    CDC_ENS_create("PhyHealth", (ModelNode*) lphd1, 0);

    LogicalNode* mmxu1 = LogicalNode_create("MMXU1", bay);
    DataObject* totW   = CDC_MV_create("TotW", (ModelNode*) mmxu1, 0, false);
    DataObject* totVAr = CDC_MV_create("TotVAr", (ModelNode*) mmxu1, 0, false);
    DataObject* hz     = CDC_MV_create("Hz", (ModelNode*) mmxu1, 0, false);
    DataObject* phV    = CDC_WYE_create("PhV", (ModelNode*) mmxu1, 0);
    DataObject* amp    = CDC_WYE_create("A", (ModelNode*) mmxu1, 0);

    DataAttribute* totW_f   = (DataAttribute*) ModelNode_getChild((ModelNode*) totW, "mag.f");
    DataAttribute* totVAr_f = (DataAttribute*) ModelNode_getChild((ModelNode*) totVAr, "mag.f");
    DataAttribute* hz_f     = (DataAttribute*) ModelNode_getChild((ModelNode*) hz, "mag.f");
    DataAttribute* phVa = (DataAttribute*) ModelNode_getChild((ModelNode*) phV, "phsA.cVal.mag.f");
    DataAttribute* phVb = (DataAttribute*) ModelNode_getChild((ModelNode*) phV, "phsB.cVal.mag.f");
    DataAttribute* phVc = (DataAttribute*) ModelNode_getChild((ModelNode*) phV, "phsC.cVal.mag.f");
    DataAttribute* Aa   = (DataAttribute*) ModelNode_getChild((ModelNode*) amp, "phsA.cVal.mag.f");
    DataAttribute* Ab   = (DataAttribute*) ModelNode_getChild((ModelNode*) amp, "phsB.cVal.mag.f");
    DataAttribute* Ac   = (DataAttribute*) ModelNode_getChild((ModelNode*) amp, "phsC.cVal.mag.f");

    LogicalNode* xcbr1 = LogicalNode_create("XCBR1", bay);
    DataObject* pos = CDC_DPC_create("Pos", (ModelNode*) xcbr1, 0, CDC_CTL_MODEL_DIRECT_NORMAL);
    xcbrPosStVal = (DataAttribute*) ModelNode_getChild((ModelNode*) pos, "stVal");

    /* ── Server ──────────────────────────────────────────────────────────── */
    iedServer = IedServer_create(model);
    IedServer_setControlHandler(iedServer, pos, (ControlHandler) posControlHandler, NULL);

    IedServer_start(iedServer, tcpPort);
    if (!IedServer_isRunning(iedServer)) {
        printf("[ics-iec61850] ERROR: MMS server failed to start on port %d\n", tcpPort);
        IedServer_destroy(iedServer);
        IedModel_destroy(model);
        return -1;
    }

    /* Breaker starts closed (energized feeder). */
    if (xcbrPosStVal != NULL)
        IedServer_updateDbposValue(iedServer, xcbrPosStVal, DBPOS_ON);

    printf("[ics-iec61850] IED model 'OTForgeIED/BAY' serving MMS on port %d\n", tcpPort);
    printf("[ics-iec61850] MMXU1 measurements live; XCBR1.Pos is client-controllable.\n");
    fflush(stdout);

    running = 1;
    signal(SIGINT, sigint_handler);

    int t = 0;
    while (running) {
        /* Triangle-wave wobble in [-10, +10], integer math (no libm). */
        int phase = t % 40;
        float wobble = (float) ((phase < 20 ? phase : 40 - phase) - 10);

        /* Simulated 13.8 kV feeder: ~200 A, ~4 MW, ~0.8 MVAr, 60 Hz. */
        float v   = 13800.0f + 4.0f * wobble;
        float a   = 200.0f + 0.8f * wobble;
        float w   = 4000000.0f + 5000.0f * wobble;
        float var = 800000.0f + 3000.0f * wobble;
        float f   = 60.0f + 0.002f * wobble;

        IedServer_lockDataModel(iedServer);
        updateIfPresent(totW_f, w);
        updateIfPresent(totVAr_f, var);
        updateIfPresent(hz_f, f);
        updateIfPresent(phVa, v);
        updateIfPresent(phVb, v);
        updateIfPresent(phVc, v);
        updateIfPresent(Aa, a);
        updateIfPresent(Ab, a);
        updateIfPresent(Ac, a);
        IedServer_unlockDataModel(iedServer);

        t++;
        Thread_sleep(1000);
    }

    IedServer_stop(iedServer);
    IedServer_destroy(iedServer);
    IedModel_destroy(model);
    return 0;
}
