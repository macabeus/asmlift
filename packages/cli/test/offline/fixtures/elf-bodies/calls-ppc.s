	.text
	.globl rd1
	.type rd1, @function
rd1:
	addi 3,3,1
	blr
	.size rd1, .-rd1
	.globl rd0
	.type rd0, @function
rd0:
	li 3,0
	blr
	.size rd0, .-rd0
	.globl cj
	.type cj, @function
cj:
	mflr 0
	stw 0,4(1)
	stwu 1,-8(1)
	bl rd1
	lwz 0,12(1)
	addi 1,1,8
	mtlr 0
	blr
	.size cj, .-cj
	.globl cz
	.type cz, @function
cz:
	mflr 0
	stw 0,4(1)
	stwu 1,-8(1)
	li 3,0
	bl rd1
	lwz 0,12(1)
	addi 1,1,8
	mtlr 0
	blr
	.size cz, .-cz
	.type st, @function
st:
	blr
	.size st, .-st
	.globl cst
	.type cst, @function
cst:
	mflr 0
	stw 0,4(1)
	stwu 1,-8(1)
	bl st
	lwz 0,12(1)
	addi 1,1,8
	mtlr 0
	blr
	.size cst, .-cst
