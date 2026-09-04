	thumb_func_start UpdateHUDCollectibleCount
UpdateHUDCollectibleCount: @ 08025F94
	push {r4, r5, r6, r7, lr}
	ldr r0, _08025FE0 @ =0x03005220
	adds r5, r0, #0x0
	adds r5, #0x4C
	ldrb r1, [r5, #0x00]
	adds r7, r0, #0x0
	cmp r1, #0x09
	bls _08025FF8
	ldr r4, _08025FE4 @ =0x03000900
	adds r0, r1, #0x0
	movs r1, #0x0A
	bl sub_08051A0C
	lsls r0, r0, #0x18
	lsrs r0, r0, #0x17
	ldr r1, _08025FE8 @ =0x00000524
	adds r0, r0, r1
	adds r0, r0, r4
	ldrh r1, [r0, #0x00]
	ldr r2, _08025FEC @ =0x000004B6
	adds r0, r4, r2
	strh r1, [r0, #0x00]
	ldrb r0, [r5, #0x00]
	movs r1, #0x0A
	bl sub_08051A0C
	lsls r0, r0, #0x18
	lsrs r0, r0, #0x17
	ldr r1, _08025FF0 @ =0x00000564
	adds r0, r0, r1
	adds r0, r0, r4
	ldrh r1, [r0, #0x00]
	ldr r2, _08025FF4 @ =0x000004F6
	adds r0, r4, r2
	strh r1, [r0, #0x00]
	adds r6, r4, #0x0
	b _08026032
	lsls r0, r0, #0x00
_08025FE0: .4byte 0x03005220
_08025FE4: .4byte 0x03000900
_08025FE8: .4byte 0x00000524
_08025FEC: .4byte 0x000004B6
_08025FF0: .4byte 0x00000564
_08025FF4: .4byte 0x000004F6
_08025FF8:
	ldr r6, _08026074 @ =0x03000900
	cmp r1, #0x09
	bne _08026032
	ldrb r0, [r5, #0x00]
	movs r1, #0x0A
	bl sub_08051A0C
	lsls r0, r0, #0x18
	lsrs r0, r0, #0x17
	ldr r1, _08026078 @ =0x000004BC
	adds r0, r0, r1
	adds r0, r0, r6
	ldrh r1, [r0, #0x00]
	ldr r2, _0802607C @ =0x000004B6
	adds r0, r6, r2
	strh r1, [r0, #0x00]
	ldrb r0, [r5, #0x00]
	movs r1, #0x0A
	bl sub_08051A0C
	lsls r0, r0, #0x18
	lsrs r0, r0, #0x17
	ldr r1, _08026080 @ =0x000004FC
	adds r0, r0, r1
	adds r0, r0, r6
	ldrh r1, [r0, #0x00]
	ldr r2, _08026084 @ =0x000004F6
	adds r0, r6, r2
	strh r1, [r0, #0x00]
_08026032:
	adds r4, r7, #0x0
	adds r4, #0x4C
	ldrb r0, [r4, #0x00]
	movs r1, #0x0A
	bl sub_08051A84
	lsls r0, r0, #0x18
	lsrs r0, r0, #0x17
	ldr r1, _08026088 @ =0x00000524
	adds r0, r0, r1
	adds r0, r0, r6
	ldrh r1, [r0, #0x00]
	movs r2, #0x97
	lsls r2, r2, #0x03
	adds r0, r6, r2
	strh r1, [r0, #0x00]
	ldrb r0, [r4, #0x00]
	movs r1, #0x0A
	bl sub_08051A84
	lsls r0, r0, #0x18
	lsrs r0, r0, #0x17
	ldr r1, _0802608C @ =0x00000564
	adds r0, r0, r1
	adds r0, r0, r6
	ldrh r1, [r0, #0x00]
	movs r2, #0x9F
	lsls r2, r2, #0x03
	adds r0, r6, r2
	strh r1, [r0, #0x00]
	pop {r4, r5, r6, r7}
	pop {r0}
	bx r0
_08026074: .4byte 0x03000900
_08026078: .4byte 0x000004BC
_0802607C: .4byte 0x000004B6
_08026080: .4byte 0x000004FC
_08026084: .4byte 0x000004F6
_08026088: .4byte 0x00000524
_0802608C: .4byte 0x00000564
