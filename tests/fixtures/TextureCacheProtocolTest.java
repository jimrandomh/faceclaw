package com.faceclaw.app;

import java.lang.reflect.*;
import java.util.*;

public class TextureCacheProtocolTest {
    static int u16(byte[] b, int p) { return (b[p]&255) | (b[p+1]&255)<<8; }
    static int u32(byte[] b, int p) { return u16(b,p) | u16(b,p+2)<<16; }
    public static void main(String[] args) throws Exception {
        TextureCacheState cache = new TextureCacheState();
        byte[] pixels = new byte[255*255];
        for (int i=0;i<pixels.length;i++) pixels[i]=(byte)(i%15+1);
        ImageAtlas.Entry big = new ImageAtlas.Entry(255,255,pixels);
        for (int i=0;i<3;i++) assert cache.ensureImage(i,big)>=0;
        ImageAtlas.Entry tiny = new ImageAtlas.Entry(1,1,new byte[]{15});
        int imageOffset = cache.ensureImage(100,tiny);
        assert imageOffset>65535;
        GlyphAtlas.Glyph glyph = new GlyphAtlas.Glyph(1,1,0,1,0,null,new byte[]{15});
        int glyphOffset = cache.ensureGlyph(42,'A',glyph);
        int table = cache.fontTableOffset(42);
        assert table>65535 && glyphOffset==table+96*4;
        byte[] memory = new byte[262144];
        for (byte[] upload: cache.drainUploadPayloads(3600)) {
            assert upload[0]==18;
            int pos=1;
            while (pos<upload.length) {
                int offset=u32(upload,pos), n=u16(upload,pos+4);
                System.arraycopy(upload,pos+6,memory,offset,n); pos+=6+n;
            }
            assert pos==upload.length;
        }
        assert memory[imageOffset]==1 && memory[imageOffset+2]==0x1f;
        assert u32(memory,table+('A'-32)*4)==glyphOffset;
        assert !cache.hasPendingUploads();
        // Exercise the production planner encoders with offsets above 64 KiB.
        Class<?> selected=Class.forName("com.faceclaw.app.TexturePlanner$Selected");
        Constructor<?> ctor=selected.getDeclaredConstructors()[0]; ctor.setAccessible(true);
        Object image=ctor.newInstance(SurfaceCompositor.ScreenDraw.image(100,321,123),null,tiny,321,15);
        Method encode=TexturePlanner.class.getDeclaredMethod("encodeImageDraw",TextureCacheState.class,selected);
        encode.setAccessible(true);
        byte[] draw=(byte[])encode.invoke(null,cache,image);
        assert draw.length==10 && draw[0]==19 && u32(draw,1)==imageOffset;
        assert u16(draw,5)==321 && u16(draw,7)==123 && draw[9]==31;
        Object letter=ctor.newInstance(SurfaceCompositor.ScreenDraw.glyph(42,'A',321,123,255),glyph,null,321,15);
        Method runs=TexturePlanner.class.getDeclaredMethod("buildRuns",TextureCacheState.class,List.class,List.class);
        runs.setAccessible(true); List<byte[]> out=new ArrayList<>();
        runs.invoke(null,cache,Collections.singletonList(letter),out);
        byte[] run=out.get(0);
        assert run.length==12 && run[0]==20 && u32(run,1)==table;
        assert u16(run,5)==321 && u16(run,7)==123 && run[9]==31 && run[10]==1 && run[11]=='A';
        int id=200;
        while (cache.ensureImage(id++,big)>=0) {}
        int before=cache.usedBytes();
        assert cache.ensureImage(id,big)==-1 && cache.usedBytes()==before;
        cache.reset(); assert cache.usedBytes()==0 && !cache.hasPendingUploads();
        assert cache.ensureImage(id,tiny)==0;
    }
}
