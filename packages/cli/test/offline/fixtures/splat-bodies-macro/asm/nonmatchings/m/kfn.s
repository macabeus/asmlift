	.text
	thumb_func_start kfn
kfn:
	ldr	r1, .Lp_kfn
	str	r0, [r1]
	bx	lr
	.align	2, 0
.Lp_kfn:
	.4byte	gp
	thumb_func_end kfn
