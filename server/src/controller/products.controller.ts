import { ProductModel } from "../model/product.model.js";

class ProductsController {
    private productModel = new ProductModel();

    list() {
        return this.productModel.list();
    }
}

export { ProductsController }