SECTIONS { . = 0x08000000; .text : { *(.text) } /DISCARD/ : { *(.ARM.attributes) } }
