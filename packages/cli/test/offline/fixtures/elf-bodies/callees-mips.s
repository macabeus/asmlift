	.set	noreorder
	.text
	.globl	rd0
	.type	rd0, @function
rd0:
	jr	$ra
	li	$v0, 1
	.size	rd0, .-rd0
	.globl	rd1
	.type	rd1, @function
rd1:
	jr	$ra
	addiu	$v0, $a0, 1
	.size	rd1, .-rd1
	.weak	wk
	.type	wk, @function
wk:
	jr	$ra
	li	$v0, 0
	.size	wk, .-wk
	.globl	un0
	.type	un0, @function
un0:
	jr	$ra
	li	$v0, 2
	.globl	last
	.type	last, @function
last:
	jr	$ra
	li	$v0, 3
