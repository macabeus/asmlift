	.set	noreorder
	.text
	.globl	rd1
	.type	rd1, @function
rd1:
	jr	$ra
	addiu	$v0, $a0, 1
	.size	rd1, .-rd1
	.globl	rd1b
	.type	rd1b, @function
	.globl	rd1alias
	.type	rd1alias, @function
rd1b:
rd1alias:
	jr	$ra
	addiu	$v0, $a0, 2
	.size	rd1b, .-rd1b
	.size	rd1alias, .-rd1alias
	.type	dup, @function
dup:
	jr	$ra
	addiu	$v0, $a0, 3
	.size	dup, .-dup
	.globl	cj
	.type	cj, @function
cj:
	addiu	$sp, $sp, -24
	sw	$ra, 16($sp)
	jal	rd1
	nop
	lw	$ra, 16($sp)
	jr	$ra
	addiu	$sp, $sp, 24
	.size	cj, .-cj
	.globl	cz
	.type	cz, @function
cz:
	addiu	$sp, $sp, -24
	sw	$ra, 16($sp)
	jal	rd1
	move	$a0, $zero
	lw	$ra, 16($sp)
	jr	$ra
	addiu	$sp, $sp, 24
	.size	cz, .-cz
	.globl	calias
	.type	calias, @function
calias:
	addiu	$sp, $sp, -24
	sw	$ra, 16($sp)
	jal	rd1b
	move	$a0, $zero
	lw	$ra, 16($sp)
	jr	$ra
	addiu	$sp, $sp, 24
	.size	calias, .-calias
	.globl	cdup
	.type	cdup, @function
cdup:
	addiu	$sp, $sp, -24
	sw	$ra, 16($sp)
	jal	dup
	move	$a0, $zero
	lw	$ra, 16($sp)
	jr	$ra
	addiu	$sp, $sp, 24
	.size	cdup, .-cdup
	.globl	covl
	.type	covl, @function
covl:
	addiu	$sp, $sp, -24
	sw	$ra, 16($sp)
	jal	ovl_a
	move	$a0, $zero
	lw	$ra, 16($sp)
	jr	$ra
	addiu	$sp, $sp, 24
	.size	covl, .-covl

	.section .ovl_a, "ax", @progbits
	.globl	ovl_a
	.type	ovl_a, @function
ovl_a:
	jr	$ra
	addiu	$v0, $a0, 4
	.size	ovl_a, .-ovl_a
	.globl	cin_a
	.type	cin_a, @function
cin_a:
	addiu	$sp, $sp, -24
	sw	$ra, 16($sp)
	jal	ovl_a
	move	$a0, $zero
	lw	$ra, 16($sp)
	jr	$ra
	addiu	$sp, $sp, 24
	.size	cin_a, .-cin_a

	.section .ovl_b, "ax", @progbits
	.globl	ovl_b
	.type	ovl_b, @function
ovl_b:
	jr	$ra
	addiu	$v0, $a0, 5
	.size	ovl_b, .-ovl_b
